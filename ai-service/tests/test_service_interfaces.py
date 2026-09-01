import asyncio
from typing import Tuple, Optional
from app.services.base_stt import SpeechToTextService
from app.services.base_tts import TextToSpeechService
from app.services.base_audio import AudioProcessor
from app.services.base_vad import VoiceActivityDetector
from app.models.lifecycle import ModelLifecycleManager

class DummySTTService(SpeechToTextService):
    def __init__(self):
        self._ready = False

    async def initialize(self) -> None:
        self._ready = True

    async def shutdown(self) -> None:
        self._ready = False

    def is_ready(self) -> bool:
        return self._ready

    async def transcribe(self, audio_bytes: bytes, filename: str = "audio.wav", language: Optional[str] = None) -> Tuple[str, float, str, float]:
        return ("dummy text", 1.0, "en", 1.0)

class DummyTTSService(TextToSpeechService):
    def __init__(self):
        self._ready = False

    async def initialize(self) -> None:
        self._ready = True

    async def shutdown(self) -> None:
        self._ready = False

    def is_ready(self) -> bool:
        return self._ready

    async def synthesize(self, text: str, voice: Optional[str] = None, speed: Optional[str] = None) -> bytes:
        return b"dummy_audio_bytes"

class DummyAudioProcessor(AudioProcessor):
    async def process_audio(self, raw_bytes: bytes, target_sample_rate: int = 16000, target_channels: int = 1) -> bytes:
        return raw_bytes

    async def get_duration(self, raw_bytes: bytes) -> float:
        return 2.5

class DummyVAD(VoiceActivityDetector):
    def is_ready(self) -> bool:
        return True

    async def detect_speech(self, audio_chunk: bytes, sample_rate: int = 16000) -> bool:
        return True

    def process_chunk(self, audio_chunk: bytes, sample_rate: int = 16000):
        from app.schemas.vad import VADResult, VADEventType
        return VADResult(
            event=VADEventType.SILENCE,
            is_speech=False,
            rms_db=-100.0,
            duration_ms=100.0,
            utterance_completed=False,
            speech_duration_ms=0.0
        )

    def reset_state(self) -> None:
        pass

def test_service_abstractions_and_lifecycle():
    async def _run_test():
        manager = ModelLifecycleManager()
        
        stt = DummySTTService()
        tts = DummyTTSService()
        audio = DummyAudioProcessor()
        vad = DummyVAD()

        manager.register_stt_service(stt)
        manager.register_tts_service(tts)
        manager.register_audio_processor(audio)
        manager.register_vad_service(vad)

        # Initial state
        assert manager.stt_service == stt
        assert manager.tts_service == tts
        assert manager.audio_processor == audio
        assert manager.vad_service == vad

        statuses = manager.get_subsystem_statuses()
        assert statuses["stt"] is False
        assert statuses["tts"] is False
        assert statuses["audio_processor"] is True
        assert statuses["vad"] is True

        # Startup
        await manager.startup()
        statuses_after_startup = manager.get_subsystem_statuses()
        assert statuses_after_startup["stt"] is True
        assert statuses_after_startup["tts"] is True

        # Functional calls
        text, conf, lang, dur = await stt.transcribe(b"test")
        assert text == "dummy text"
        
        audio_data = await tts.synthesize("hello")
        assert audio_data == b"dummy_audio_bytes"

        # Shutdown
        await manager.shutdown()
        statuses_after_shutdown = manager.get_subsystem_statuses()
        assert statuses_after_shutdown["stt"] is False
        assert statuses_after_shutdown["tts"] is False

    asyncio.run(_run_test())
