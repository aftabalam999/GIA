import json
import pytest
from app.services.llm_service import gia_llm_service, QwenLLMService
from app.schemas.llm import ChatCompletionRequest, ChatMessage, GenerateRequest

def test_llm_service_singleton_registration():
    """Verify that QwenLLMService is registered with lifecycle and has local_files_only enabled."""
    assert gia_llm_service is not None
    assert gia_llm_service.local_files_only is True

def test_tool_call_parsing():
    """Verify parsing of Qwen's documented XML <tool_call> block format."""
    sample_output = """
<think>
User wants to know the time and open VS Code.
</think>
<tool_call>
<function=get_current_time>
</function>
</tool_call>
<tool_call>
<function=open_folder_in_vscode>
<parameter=folderName>
GIA-AI
</parameter>
<parameter=windowCount>
1
</parameter>
</function>
</tool_call>
"""
    tool_calls = QwenLLMService.parse_qwen_tool_calls(sample_output)
    assert len(tool_calls) == 2
    assert tool_calls[0].function.name == "get_current_time"
    assert tool_calls[0].function.arguments == {}
    assert tool_calls[1].function.name == "open_folder_in_vscode"
    assert tool_calls[1].function.arguments == {"folderName": "GIA-AI", "windowCount": 1}

def test_reasoning_and_content_splitting():
    """Verify that <think> reasoning tokens are cleanly extracted from conversational text."""
    sample = "<think>Planning the response...</think>Hello! How can I assist you today?"
    reasoning, content = QwenLLMService.split_reasoning_and_content(sample)
    assert reasoning == "Planning the response..."
    assert content == "Hello! How can I assist you today?"

def test_json_content_enforcement():
    """Verify enforcement and stripping of markdown from JSON responses."""
    md_json = "```json\n{\"status\": \"ok\", \"count\": 42}\n```"
    enforced = QwenLLMService._enforce_json_content(md_json)
    parsed = json.loads(enforced)
    assert parsed["status"] == "ok"
    assert parsed["count"] == 42

def test_get_llm_health_endpoint(client):
    """GET /api/llm/health returns status and model info."""
    response = client.get("/api/llm/health")
    assert response.status_code == 200
    data = response.json()
    assert data["model_name"] == "Qwen3.5-4B"
    assert "ready" in data
    assert "device" in data
    assert "status" in data

def test_get_llm_info_endpoint(client):
    """GET /api/llm/info returns architectural parameters."""
    response = client.get("/api/llm/info")
    assert response.status_code == 200
    data = response.json()
    assert data["model_name"] == "Qwen3.5-4B"
    assert data["local_files_only"] is True
    assert "Qwen" in data["architecture"]
    assert data["vocab_size"] > 200000
    assert data["context_length"] >= 32768

def test_chat_validation_error_empty_messages(client):
    """POST /api/llm/chat with empty messages yields 400 Bad Request."""
    response = client.post("/api/llm/chat", json={"messages": []})
    assert response.status_code == 400
    err_msg = response.json().get("error", {}).get("message") or response.json().get("detail", "")
    assert "Messages list must contain at least one message" in err_msg

def test_generate_validation_error_empty_prompt(client):
    """POST /api/llm/generate with empty prompt yields 400 Bad Request."""
    response = client.post("/api/llm/generate", json={"prompt": "   "})
    assert response.status_code == 400
    err_msg = response.json().get("error", {}).get("message") or response.json().get("detail", "")
    assert "Prompt text must not be empty" in err_msg

def test_chat_completion_e2e(client):
    """POST /api/llm/chat performs synchronous inference with Qwen 3.5 4B."""
    payload = {
        "messages": [
            {"role": "system", "content": "You are a helpful assistant."},
            {"role": "user", "content": "Say the exact word 'ANTIGRAVITY'."}
        ],
        "temperature": 0.0,
        "max_new_tokens": 20
    }
    response = client.post("/api/llm/chat", json=payload)
    assert response.status_code == 200
    data = response.json()
    assert "id" in data
    assert data["model"] == "Qwen3.5-4B"
    assert len(data["choices"]) > 0
    assert data["usage"]["total_tokens"] > 0
    message = data["choices"][0]["message"]
    assert "role" in message
    assert message["role"] == "assistant"
    assert isinstance(message["content"], str)

def test_chat_streaming_e2e(client):
    """POST /api/llm/chat/stream streams SSE chunks and terminates with [DONE]."""
    payload = {
        "messages": [
            {"role": "user", "content": "Count from 1 to 3."}
        ],
        "temperature": 0.0,
        "max_new_tokens": 25
    }
    response = client.post("/api/llm/chat/stream", json=payload)
    assert response.status_code == 200
    assert "text/event-stream" in response.headers["content-type"]
    lines = response.text.split("\n")
    data_lines = [line for line in lines if line.startswith("data:")]
    assert len(data_lines) > 0
    assert any("[DONE]" in line for line in data_lines)

def test_generate_e2e(client):
    """POST /api/llm/generate generates raw text completion."""
    payload = {
        "prompt": "The capital of France is",
        "temperature": 0.0,
        "max_new_tokens": 10
    }
    response = client.post("/api/llm/generate", json=payload)
    assert response.status_code == 200
    data = response.json()
    assert "text" in data
    assert data["prompt_tokens"] > 0
    assert data["completion_tokens"] > 0
    assert "Paris" in data["text"]

def test_chat_multi_turn_history(client):
    """POST /api/llm/chat handles multi-turn conversation history."""
    payload = {
        "messages": [
            {"role": "user", "content": "My name is Aftab."},
            {"role": "assistant", "content": "Hello Aftab! How can I help you today?"},
            {"role": "user", "content": "What is my name?"}
        ],
        "temperature": 0.0,
        "max_new_tokens": 120
    }
    response = client.post("/api/llm/chat", json=payload)
    assert response.status_code == 200
    data = response.json()
    content = data["choices"][0]["message"]["content"]
    assert "Aftab" in content

def test_chat_json_structured_output(client):
    """POST /api/llm/chat returns structured JSON when response_format is json_object."""
    payload = {
        "messages": [
            {"role": "user", "content": "Output a JSON with a single key 'project' with value 'GIA'."}
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0.0,
        "max_new_tokens": 250
    }
    response = client.post("/api/llm/chat", json=payload)
    assert response.status_code == 200
    data = response.json()
    content = data["choices"][0]["message"]["content"]
    parsed = json.loads(content)
    assert parsed.get("project") == "GIA"


