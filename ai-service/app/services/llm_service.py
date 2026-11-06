import os
import re
import time
import json
import uuid
import asyncio
import logging
from threading import Thread
from typing import List, Dict, Any, Optional, AsyncGenerator, Tuple

import torch
from transformers import (
    AutoConfig,
    AutoTokenizer,
    AutoModelForCausalLM,
    TextIteratorStreamer
)

from app.core.config import settings
from app.schemas.llm import (
    ChatMessage,
    ChatCompletionRequest,
    ChatCompletionResponse,
    ChatChoice,
    ChatChoiceMessage,
    UsageInfo,
    GenerateRequest,
    GenerateResponse,
    LLMHealthResponse,
    LLMInfoResponse,
    ToolCall,
    ToolCallFunction,
)

logger = logging.getLogger("ai_service.llm_service")

class QwenLLMService:
    """
    Production-ready local inference engine for Qwen 3.5 4B on Apple Silicon / CPU.
    Loads weights strictly from local disk (local_files_only=True) with zero internet access.
    Supports streaming (TextIteratorStreamer), non-streaming completions, conversation history,
    native XML tool calling, structured JSON formatting, and deep reasoning extraction.
    """

    def __init__(
        self,
        model_path: Optional[str] = None,
        device: Optional[str] = None,
        dtype: Optional[str] = None,
        local_files_only: bool = True
    ):
        self.model_path = self._resolve_model_path(model_path or settings.LLM_MODEL_PATH)
        self.configured_device = device or settings.LLM_DEVICE
        self.configured_dtype = dtype or settings.LLM_DTYPE
        self.local_files_only = local_files_only

        self._state: str = "UNINITIALIZED"
        self._init_error: Optional[str] = None
        self._device: str = "cpu"
        self._torch_dtype: torch.dtype = torch.bfloat16

        self.tokenizer = None
        self.model = None
        self.config = None

        self._lifecycle_lock = asyncio.Lock()
        self._inference_lock = asyncio.Lock()

    @staticmethod
    def _resolve_model_path(path: str) -> str:
        """Resolves local model directory across project and service working directories."""
        if os.path.isabs(path) and os.path.exists(path):
            return path
        candidates = [
            path,
            os.path.join(os.getcwd(), path),
            os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", path)),
            os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "models", "Qwen")),
            os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "models", "Qwen3.5-4b")),
        ]
        for c in candidates:
            if os.path.exists(c) and os.path.isdir(c):
                return c
        return path

    def _select_device_and_dtype(self) -> Tuple[str, torch.dtype]:
        """Chooses Apple Silicon MPS when available, falling back safely to CPU."""
        target_device = "cpu"
        if self.configured_device == "mps" or self.configured_device == "auto":
            if torch.backends.mps.is_available():
                target_device = "mps"
        elif self.configured_device == "cuda":
            if torch.cuda.is_available():
                target_device = "cuda"

        if target_device in ("mps", "cuda"):
            target_dtype = torch.bfloat16
        else:
            target_dtype = torch.float32

        return target_device, target_dtype

    @property
    def is_initialized(self) -> bool:
        return self._state == "READY" and self.model is not None and self.tokenizer is not None

    def is_ready(self) -> bool:
        return self.is_initialized

    def get_status(self) -> LLMHealthResponse:
        mem_mb = None
        if self._device == "mps" and hasattr(torch.mps, "current_allocated_memory"):
            try:
                mem_mb = round(torch.mps.current_allocated_memory() / (1024 * 1024), 2)
            except Exception:
                pass

        return LLMHealthResponse(
            status="healthy" if self.is_ready() else ("loading" if self._state == "LOADING" else "unhealthy"),
            ready=self.is_ready(),
            model_loaded=self.model is not None,
            device=self._device,
            model_name=settings.LLM_MODEL_NAME,
            memory_used_mb=mem_mb,
        )

    def get_info(self) -> LLMInfoResponse:
        context_len = 262144
        arch = "Qwen3_5ForConditionalGeneration"
        if self.config:
            arch = getattr(self.config, "architectures", [arch])[0]
            text_cfg = getattr(self.config, "text_config", None)
            if text_cfg:
                context_len = getattr(text_cfg, "max_position_embeddings", context_len)
            else:
                context_len = getattr(self.config, "max_position_embeddings", context_len)

        return LLMInfoResponse(
            model_name=settings.LLM_MODEL_NAME,
            model_path=self.model_path,
            architecture=arch,
            device=self._device,
            dtype=str(self._torch_dtype).replace("torch.", ""),
            context_length=context_len,
            vocab_size=len(self.tokenizer) if self.tokenizer else 0,
            local_files_only=self.local_files_only,
            parameters="~4.5B (hybrid linear/full attention with vision)",
        )

    async def initialize(self) -> None:
        """Loads model weights once into unified memory during application startup."""
        async with self._lifecycle_lock:
            if self.is_initialized:
                return

            self._state = "LOADING"
            self._init_error = None
            logger.info(f"Loading local Qwen model from: '{self.model_path}'...")

            if not os.path.exists(self.model_path):
                err = f"Model path '{self.model_path}' does not exist on disk"
                self._state = "FAILED"
                self._init_error = err
                logger.error(err)
                raise FileNotFoundError(err)

            self._device, self._torch_dtype = self._select_device_and_dtype()
            logger.info(f"Targeting device='{self._device}', dtype='{self._torch_dtype}'")

            loop = asyncio.get_running_loop()
            try:
                await loop.run_in_executor(None, self._load_model_sync)
                self._state = "READY"
                logger.info(f"Qwen 3.5 4B model successfully loaded on {self._device} and ready for inference!")
            except Exception as e:
                self._state = "FAILED"
                self._init_error = str(e)
                logger.exception(f"Failed to load Qwen model: {e}")
                raise

    def _load_model_sync(self) -> None:
        """Synchronous loader executed in worker thread to prevent event loop blocking."""
        logger.info(f"Loading tokenizer with local_files_only={self.local_files_only}...")
        self.tokenizer = AutoTokenizer.from_pretrained(
            self.model_path,
            local_files_only=self.local_files_only,
            trust_remote_code=True
        )

        logger.info(f"Loading model config with local_files_only={self.local_files_only}...")
        self.config = AutoConfig.from_pretrained(
            self.model_path,
            local_files_only=self.local_files_only,
            trust_remote_code=True
        )

        logger.info(f"Loading model safetensors on {self._device} with dtype={self._torch_dtype}...")
        self.model = AutoModelForCausalLM.from_pretrained(
            self.model_path,
            config=self.config,
            dtype=self._torch_dtype,
            local_files_only=self.local_files_only,
            low_cpu_mem_usage=True,
            trust_remote_code=True
        )
        self.model.to(self._device)
        self.model.eval()

        # Enforce explicit EOS token IDs in generation_config for timely termination
        if hasattr(self.model, "generation_config") and self.model.generation_config is not None:
            self.model.generation_config.eos_token_id = [self.tokenizer.eos_token_id, 248044]
            self.model.generation_config.pad_token_id = self.tokenizer.eos_token_id

    async def shutdown(self) -> None:
        """Gracefully unloads model and frees MPS / RAM memory."""
        async with self._lifecycle_lock:
            logger.info("Unloading local Qwen model and cleaning up resources...")
            self.model = None
            self.tokenizer = None
            self.config = None
            self._state = "SHUTDOWN"

            if self._device == "mps" and hasattr(torch.mps, "empty_cache"):
                try:
                    torch.mps.empty_cache()
                except Exception:
                    pass
            logger.info("Local Qwen model resources successfully released.")

    # --------------------------------------------------------------------------
    # Text Generation & Formatting Utilities
    # --------------------------------------------------------------------------

    @staticmethod
    def parse_qwen_tool_calls(text: str) -> List[ToolCall]:
        """Parses Qwen's documented XML <tool_call> blocks into structured ToolCall objects."""
        tool_calls = []
        blocks = re.findall(r"<tool_call>(.*?)</tool_call>", text, re.DOTALL)
        for block in blocks:
            fn_match = re.search(r"<function=([a-zA-Z0-9_-]+)>(.*?)</function>", block, re.DOTALL)
            if fn_match:
                fn_name = fn_match.group(1).strip()
                fn_body = fn_match.group(2)
                params: Dict[str, Any] = {}
                param_matches = re.findall(r"<parameter=([a-zA-Z0-9_-]+)>(.*?)</parameter>", fn_body, re.DOTALL)
                for p_name, p_val in param_matches:
                    p_val_clean = p_val.strip()
                    try:
                        params[p_name] = json.loads(p_val_clean)
                    except Exception:
                        params[p_name] = p_val_clean

                call_id = f"call_{uuid.uuid4().hex[:8]}"
                tool_calls.append(
                    ToolCall(
                        id=call_id,
                        type="function",
                        function=ToolCallFunction(name=fn_name, arguments=params),
                    )
                )
        return tool_calls

    @staticmethod
    def split_reasoning_and_content(raw_text: str) -> Tuple[Optional[str], str]:
        """Extracts <think>...</think> chain-of-thought tokens from final message content."""
        reasoning = None
        content = raw_text

        if "<think>" in raw_text:
            parts = raw_text.split("</think>", 1)
            if len(parts) == 2:
                think_block = parts[0].split("<think>", 1)[-1]
                reasoning = think_block.strip()
                content = parts[1].strip()
            else:
                # Unfinished think block
                think_block = raw_text.split("<think>", 1)[-1]
                reasoning = think_block.strip()
                content = ""

        # Remove raw <tool_call>...</tool_call> tags from conversational text if present
        content = re.sub(r"<tool_call>.*?</tool_call>", "", content, flags=re.DOTALL).strip()
        return reasoning, content

    def format_chat_prompt(
        self,
        messages: List[ChatMessage],
        system_prompt: Optional[str] = None,
        tools: Optional[List[Dict[str, Any]]] = None,
        response_format: Optional[Dict[str, Any]] = None,
        enable_thinking: bool = False,
    ) -> str:
        """Converts message history into Qwen chat template prompt string."""
        formatted_messages = []

        # System prompt handling (enforce GIA identity if none provided)
        base_system = system_prompt or settings.LLM_SYSTEM_PROMPT
        if response_format and response_format.get("type") == "json_object":
            base_system += "\nIMPORTANT: You must respond ONLY with a valid JSON object. Do not include markdown codeblocks or conversational commentary."

        # Add system prompt as initial message
        formatted_messages.append({"role": "system", "content": base_system})

        for msg in messages:
            if msg.role == "system":
                # Append to existing system prompt
                formatted_messages[0]["content"] += f"\n{msg.content}"
            elif msg.role in ("user", "assistant"):
                formatted_messages.append({"role": msg.role, "content": msg.content or ""})
            elif msg.role == "tool":
                # Format tool response
                tool_text = f"<tool_response>\n{msg.content or ''}\n</tool_response>"
                formatted_messages.append({"role": "user", "content": tool_text})

        # Apply Qwen Jinja template
        tools_payload = None
        if tools:
            tools_payload = [t if isinstance(t, dict) else t.dict() for t in tools]

        prompt_str = self.tokenizer.apply_chat_template(
            formatted_messages,
            tools=tools_payload,
            tokenize=False,
            add_generation_prompt=True,
            enable_thinking=enable_thinking,
        )
        return prompt_str

    # --------------------------------------------------------------------------
    # Inference Endpoints (Async Public Interface)
    # --------------------------------------------------------------------------

    async def chat(self, request: ChatCompletionRequest) -> ChatCompletionResponse:
        """Asynchronously generates a non-streaming chat completion."""
        if not self.is_initialized:
            await self.initialize()

        async with self._inference_lock:
            loop = asyncio.get_running_loop()
            return await loop.run_in_executor(None, self._chat_sync, request)

    def _chat_sync(self, request: ChatCompletionRequest) -> ChatCompletionResponse:
        """Executes non-streaming generation in a worker thread."""
        prompt_text = self.format_chat_prompt(
            messages=request.messages,
            system_prompt=request.system_prompt,
            tools=[t.dict() for t in request.tools] if request.tools else None,
            response_format=request.response_format,
            enable_thinking=bool(request.enable_thinking),
        )

        inputs = self.tokenizer(prompt_text, return_tensors="pt").to(self._device)
        prompt_tokens = inputs.input_ids.shape[1]

        gen_kwargs: Dict[str, Any] = {
            "max_new_tokens": request.max_new_tokens or settings.LLM_MAX_NEW_TOKENS,
            "do_sample": (request.temperature or 0.0) > 0.0,
            "pad_token_id": self.tokenizer.eos_token_id,
            "eos_token_id": [self.tokenizer.eos_token_id, 248044],
        }
        if gen_kwargs["do_sample"]:
            gen_kwargs["temperature"] = request.temperature
            gen_kwargs["top_p"] = request.top_p or settings.LLM_TOP_P

        with torch.no_grad():
            outputs = self.model.generate(**inputs, **gen_kwargs)

        generated_token_ids = outputs[0][prompt_tokens:]
        completion_tokens = len(generated_token_ids)
        raw_text = self.tokenizer.decode(generated_token_ids, skip_special_tokens=True)

        # Parse reasoning content and tool calls
        reasoning, content = self.split_reasoning_and_content(raw_text)
        tool_calls = self.parse_qwen_tool_calls(raw_text)

        finish_reason = "tool_calls" if tool_calls else "stop"

        # Validate structured JSON if requested
        if request.response_format and request.response_format.get("type") == "json_object":
            content = self._enforce_json_content(content)

        response_id = f"chatcmpl-{uuid.uuid4().hex}"
        return ChatCompletionResponse(
            id=response_id,
            created=int(time.time()),
            model=request.model or settings.LLM_MODEL_NAME,
            choices=[
                ChatChoice(
                    index=0,
                    message=ChatChoiceMessage(
                        role="assistant",
                        content=content,
                        reasoning_content=reasoning,
                        tool_calls=tool_calls if tool_calls else None,
                    ),
                    finish_reason=finish_reason,
                )
            ],
            usage=UsageInfo(
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
                total_tokens=prompt_tokens + completion_tokens,
            ),
        )

    async def stream_chat(self, request: ChatCompletionRequest) -> AsyncGenerator[str, None]:
        """Asynchronously streams generated tokens using TextIteratorStreamer formatted for SSE."""
        if not self.is_initialized:
            await self.initialize()

        prompt_text = self.format_chat_prompt(
            messages=request.messages,
            system_prompt=request.system_prompt,
            tools=[t.dict() for t in request.tools] if request.tools else None,
            response_format=request.response_format,
            enable_thinking=bool(request.enable_thinking),
        )

        inputs = self.tokenizer(prompt_text, return_tensors="pt").to(self._device)
        streamer = TextIteratorStreamer(self.tokenizer, skip_prompt=True, skip_special_tokens=True)

        gen_kwargs: Dict[str, Any] = {
            "max_new_tokens": request.max_new_tokens or settings.LLM_MAX_NEW_TOKENS,
            "do_sample": (request.temperature or 0.0) > 0.0,
            "streamer": streamer,
            "pad_token_id": self.tokenizer.eos_token_id,
            "eos_token_id": [self.tokenizer.eos_token_id, 248044],
        }
        if gen_kwargs["do_sample"]:
            gen_kwargs["temperature"] = request.temperature
            gen_kwargs["top_p"] = request.top_p or settings.LLM_TOP_P

        generation_kwargs = dict(**inputs, **gen_kwargs)
        generation_thread = Thread(target=self.model.generate, kwargs=generation_kwargs)
        generation_thread.start()

        stream_id = f"chatcmpl-{uuid.uuid4().hex}"

        try:
            for text_chunk in streamer:
                if not text_chunk:
                    continue
                # Server-Sent Event data packet
                sse_data = {
                    "id": stream_id,
                    "object": "chat.completion.chunk",
                    "created": int(time.time()),
                    "model": request.model or settings.LLM_MODEL_NAME,
                    "choices": [
                        {
                            "index": 0,
                            "delta": {"content": text_chunk},
                            "finish_reason": None,
                        }
                    ],
                }
                yield f"data: {json.dumps(sse_data)}\n\n"
                await asyncio.sleep(0)  # yield control back to event loop

            # Final closing SSE chunk
            final_data = {
                "id": stream_id,
                "object": "chat.completion.chunk",
                "created": int(time.time()),
                "model": request.model or settings.LLM_MODEL_NAME,
                "choices": [
                    {
                        "index": 0,
                        "delta": {},
                        "finish_reason": "stop",
                    }
                ],
            }
            yield f"data: {json.dumps(final_data)}\n\n"
            yield "data: [DONE]\n\n"
        finally:
            generation_thread.join()

    async def generate(self, request: GenerateRequest) -> GenerateResponse:
        """Asynchronously handles raw text prompt generation."""
        if not self.is_initialized:
            await self.initialize()

        async with self._inference_lock:
            loop = asyncio.get_running_loop()
            return await loop.run_in_executor(None, self._generate_sync, request)

    def _generate_sync(self, request: GenerateRequest) -> GenerateResponse:
        """Synchronous implementation of direct text generation."""
        prompt = request.prompt
        if request.system_prompt:
            prompt = f"<|im_start|>system\n{request.system_prompt}<|im_end|>\n<|im_start|>user\n{request.prompt}<|im_end|>\n<|im_start|>assistant\n"

        inputs = self.tokenizer(prompt, return_tensors="pt").to(self._device)
        prompt_tokens = inputs.input_ids.shape[1]

        gen_kwargs: Dict[str, Any] = {
            "max_new_tokens": request.max_new_tokens or settings.LLM_MAX_NEW_TOKENS,
            "do_sample": (request.temperature or 0.0) > 0.0,
            "pad_token_id": self.tokenizer.eos_token_id,
        }
        if gen_kwargs["do_sample"]:
            gen_kwargs["temperature"] = request.temperature
            gen_kwargs["top_p"] = request.top_p or settings.LLM_TOP_P

        with torch.no_grad():
            outputs = self.model.generate(**inputs, **gen_kwargs)

        generated_token_ids = outputs[0][prompt_tokens:]
        completion_tokens = len(generated_token_ids)
        raw_text = self.tokenizer.decode(generated_token_ids, skip_special_tokens=True).strip()

        _, clean_text = self.split_reasoning_and_content(raw_text)

        return GenerateResponse(
            text=clean_text or raw_text,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            model=request.model or settings.LLM_MODEL_NAME,
            finish_reason="stop",
        )

    @staticmethod
    def _enforce_json_content(content: str) -> str:
        """Validates or wraps output as valid JSON."""
        trimmed = content.strip()
        # Try direct JSON parsing
        try:
            json.loads(trimmed)
            return trimmed
        except Exception:
            pass

        # If wrapped in markdown block ```json ... ```, strip it
        json_match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", trimmed, re.DOTALL)
        if json_match:
            try:
                candidate = json_match.group(1).strip()
                json.loads(candidate)
                return candidate
            except Exception:
                pass

        # Search for any valid JSON object {...} in the generated text (e.g. after reasoning)
        curly_match = re.search(r"(\{[\s\S]*\})", trimmed)
        if curly_match:
            candidate = curly_match.group(1).strip()
            try:
                json.loads(candidate)
                return candidate
            except Exception:
                pass

        return json.dumps({"response": trimmed})

# Singleton instance for AI service lifecycle
gia_llm_service = QwenLLMService()

