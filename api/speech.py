"""
Voice-driven interface for chatting with Cerebras-hosted LLMs.

Requires the following third-party packages:
    pip install speechrecognition pyaudio openai cerebras-cloud-sdk langchain-core langchain

Environment variables:
    CEREBRAS_API_KEY        -> Required. Key from cerebras.ai
    CEREBRAS_MODEL          -> Optional. Defaults to "qwen-3-32b"
    CEREBRAS_BASE_URL       -> Optional. Override Cerebras endpoint (default SDK base URL)
    CEREBRAS_MAX_TOKENS     -> Optional. Max completion tokens (default 40960)
    CEREBRAS_TEMPERATURE    -> Optional. Sampling temperature (default 0.6)
    CEREBRAS_TOP_P          -> Optional. Top-p sampling cutoff (default 0.95)
    SYSTEM_PROMPT           -> Optional system instruction for the assistant
    EXIT_PHRASES            -> Optional comma-separated exit triggers (default quit/exit/stop)

Usage:
    export CEREBRAS_API_KEY="..."
    python speech.py
Speak naturally; the assistant will respond aloud. Say "quit" (or any exit phrase)
to stop the conversation.
"""

from __future__ import annotations

import asyncio
import base64
import os
import signal
import sys
import time
from dataclasses import dataclass, field
from typing import Any, List, Optional, Sequence, Tuple, Coroutine

from dotenv import load_dotenv
from pydantic import ConfigDict

try:
    from langchain_core.callbacks.manager import CallbackManagerForLLMRun
    from langchain_core.language_models.chat_models import BaseChatModel
    from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage
    from langchain_core.outputs import ChatGeneration, ChatResult
except ImportError as exc:  # pragma: no cover
    BaseChatModel = None  # type: ignore
    AIMessage = BaseMessage = HumanMessage = SystemMessage = None  # type: ignore
    ChatGeneration = ChatResult = None  # type: ignore
    CallbackManagerForLLMRun = None  # type: ignore
    _LANGCHAIN_IMPORT_ERROR = exc
else:
    _LANGCHAIN_IMPORT_ERROR = None
try:
    import speech_recognition as sr
except ImportError as exc:  # pragma: no cover
    sr = None  # type: ignore
    _SR_IMPORT_ERROR = exc
else:
    _SR_IMPORT_ERROR = None

try:
    from openai import AsyncOpenAI
    from openai.helpers import LocalAudioPlayer
except ImportError as exc:  # pragma: no cover
    AsyncOpenAI = None  # type: ignore
    LocalAudioPlayer = None  # type: ignore
    _OPENAI_IMPORT_ERROR = exc
else:
    _OPENAI_IMPORT_ERROR = None

try:
    from cerebras.cloud.sdk import Cerebras
except ImportError as exc:  # pragma: no cover
    Cerebras = None  # type: ignore
    _CEREBRAS_IMPORT_ERROR = exc
else:
    _CEREBRAS_IMPORT_ERROR = None

DEFAULT_EXIT_PHRASES: Tuple[str, ...] = ("quit", "exit", "stop", "goodbye", "good bye", "that's all")
DEFAULT_CEREBRAS_MODEL = "qwen-3-32b"
DEFAULT_MAX_TOKENS = 40960
DEFAULT_TEMPERATURE = 0.6
DEFAULT_TOP_P = 0.95


def _comma_env(name: str, fallback: Sequence[str]) -> Tuple[str, ...]:
    raw = os.getenv(name)
    if not raw:
        return tuple(fallback)
    cleaned = tuple(filter(None, (part.strip().lower() for part in raw.split(","))))
    return cleaned or tuple(fallback)
load_dotenv('.env.local')


@dataclass
class Config:
    cerebras_api_key: str = field(default_factory=lambda: os.getenv("CEREBRAS_API_KEY", ""))
    cerebras_model: str = field(default_factory=lambda: os.getenv("CEREBRAS_MODEL", DEFAULT_CEREBRAS_MODEL))
    cerebras_base_url: str = field(default_factory=lambda: os.getenv("CEREBRAS_BASE_URL", "").strip())
    system_instruction: str = field(
        default_factory=lambda: os.getenv(
            "SYSTEM_PROMPT",
            "You are a concise, friendly voice assistant. Keep replies short (under 300 characters) and easy to speak aloud. Do not use emojis.",
        )
    )

    cerebras_max_tokens: int = field(
        default_factory=lambda: int(os.getenv("CEREBRAS_MAX_TOKENS", str(DEFAULT_MAX_TOKENS)))
    )
    cerebras_temperature: float = field(
        default_factory=lambda: float(os.getenv("CEREBRAS_TEMPERATURE", str(DEFAULT_TEMPERATURE)))
    )
    cerebras_top_p: float = field(
        default_factory=lambda: float(os.getenv("CEREBRAS_TOP_P", str(DEFAULT_TOP_P)))
    )
    openai_api_key: str = field(default_factory=lambda: os.getenv("OPENAI_API_KEY", ""))
    openai_tts_model: str = field(default_factory=lambda: os.getenv("OPENAI_TTS_MODEL", "gpt-4o-mini-tts"))
    openai_tts_voice: str = field(default_factory=lambda: os.getenv("OPENAI_TTS_VOICE", "nova"))
    openai_tts_instructions: str = field(
        default_factory=lambda: os.getenv(
            "OPENAI_TTS_INSTRUCTIONS", "Speak like a professor who is helpful, yet focused"
        )
    )
    openai_tts_response_format: str = field(default_factory=lambda: os.getenv("OPENAI_TTS_RESPONSE_FORMAT", "pcm"))
    exit_phrases: Tuple[str, ...] = field(default_factory=lambda: _comma_env("EXIT_PHRASES", DEFAULT_EXIT_PHRASES))
    energy_threshold: int = field(default_factory=lambda: int(os.getenv("ENERGY_THRESHOLD", "300")))
    pause_threshold: float = field(default_factory=lambda: float(os.getenv("PAUSE_THRESHOLD", "0.8")))
    phrase_time_limit: Optional[int] = field(
        default_factory=lambda: int(os.getenv("PHRASE_TIME_LIMIT", "12")) if os.getenv("PHRASE_TIME_LIMIT") else None
    )

    def validate(self) -> None:
        if not self.cerebras_api_key:
            raise SystemExit("Missing CEREBRAS_API_KEY environment variable.")
        if Cerebras is None:  # pragma: no cover
            raise SystemExit(
                f"cerebras-cloud-sdk is not installed (pip install cerebras-cloud-sdk). Details: {_CEREBRAS_IMPORT_ERROR}"
            )
        if BaseChatModel is None:  # pragma: no cover
            raise SystemExit(
                "LangChain core packages are missing (pip install langchain-core langchain)."
                f" Details: {_LANGCHAIN_IMPORT_ERROR}"
            )
        if sr is None:  # pragma: no cover
            raise SystemExit(f"speechrecognition is not installed (pip install speechrecognition). Details: {_SR_IMPORT_ERROR}")


class SpeechRecognizer:
    """Thin wrapper around speech_recognition for blocking microphone capture."""

    def __init__(self, config: Config) -> None:
        self.recognizer = sr.Recognizer()
        self.recognizer.energy_threshold = config.energy_threshold
        self.recognizer.pause_threshold = config.pause_threshold
        self.phrase_time_limit = config.phrase_time_limit

    def listen(self) -> Optional[str]:
        with sr.Microphone() as source:
            print("Listening...")
            self.recognizer.adjust_for_ambient_noise(source, duration=1) 
            audio = self.recognizer.listen(source, phrase_time_limit=self.phrase_time_limit)
        try:
            text = self.recognizer.recognize_google(audio)
            return text.strip()
        except sr.UnknownValueError:
            print("Transcription: (could not understand audio)")
            return None
        except sr.RequestError as exc:
            print(f"Speech recognition request failed: {exc}", file=sys.stderr)
            return None


class TextToSpeechEngine:
    """OpenAI streaming text-to-speech helper."""

    def __init__(self, config: Config) -> None:
        if AsyncOpenAI is None or LocalAudioPlayer is None:  # pragma: no cover
            raise RuntimeError(
                f"openai SDK is not installed (pip install openai). Details: {_OPENAI_IMPORT_ERROR}"
            )
        if not config.openai_api_key:
            raise RuntimeError("Missing OPENAI_API_KEY environment variable.")
        self.config = config
        self.client = AsyncOpenAI(api_key=config.openai_api_key)
        self.player = LocalAudioPlayer()
        self._response_format = (self.config.openai_tts_response_format or "mp3").strip()

    def _build_request_args(self, text: str) -> dict:
        instructions = (self.config.openai_tts_instructions or "").strip()
        request_args = {
            "model": self.config.openai_tts_model,
            "voice": self.config.openai_tts_voice,
            "input": text,
            "response_format": self._response_format,
        }
        if instructions:
            request_args["instructions"] = instructions
        return request_args

    async def _stream_response(self, text: str) -> None:
        request_args = self._build_request_args(text)
        async with self.client.audio.speech.with_streaming_response.create(**request_args) as response:
            await self.player.play(response)

    async def _collect_audio_bytes(self, text: str) -> bytes:
        request_args = self._build_request_args(text)
        async with self.client.audio.speech.with_streaming_response.create(**request_args) as response:
            audio_bytes = bytearray()
            async for chunk in response.iter_bytes():
                audio_bytes.extend(chunk)
        return bytes(audio_bytes)

    @staticmethod
    def _run_async(coro: Coroutine[Any, Any, None]) -> None:
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            asyncio.run(coro)
            return
        loop.create_task(coro)

    @staticmethod
    def _run_async_with_result(coro: Coroutine[Any, Any, bytes]) -> bytes:
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return asyncio.run(coro)
        if loop.is_running():  # pragma: no cover
            raise RuntimeError("Cannot generate TTS audio while event loop is running.")
        return loop.run_until_complete(coro)

    def speak(self, text: str) -> None:
        if not text.strip():
            return
        self._run_async(self._stream_response(text.strip()))

    def synthesize_to_base64(self, text: str) -> Optional[Tuple[str, str]]:
        if not text.strip():
            return None
        audio_bytes = self._run_async_with_result(self._collect_audio_bytes(text.strip()))
        if not audio_bytes:
            return None
        encoded = base64.b64encode(audio_bytes).decode("ascii")
        return encoded, self._mime_type()

    def _mime_type(self) -> str:
        fmt = self._response_format.lower().lstrip(".")
        mapping = {
            "mp3": "audio/mpeg",
            "mpeg": "audio/mpeg",
            "wav": "audio/wav",
            "wave": "audio/wav",
            "pcm": "audio/wav",
            "ogg": "audio/ogg",
            "aac": "audio/aac",
            "flac": "audio/flac",
        }
        if fmt.startswith("audio/"):
            return fmt
        return mapping.get(fmt, f"audio/{fmt}")


class LangChainCerebrasChat(BaseChatModel):
    """LangChain-compatible chat model backed by the Cerebras SDK."""

    client: Optional[Cerebras] = None
    config: Optional[Config] = None
    last_stream_printed: bool = False
    _inside_think: bool = False

    model_config = ConfigDict(arbitrary_types_allowed=True, extra="allow")

    def __init__(self, config: Config) -> None:
        super().__init__(config=config)
        init_kwargs = {"api_key": config.cerebras_api_key}
        if config.cerebras_base_url:
            init_kwargs["base_url"] = config.cerebras_base_url
        self.client = Cerebras(**init_kwargs)
        self.config = config
        self.last_stream_printed = False
        self._inside_think = False

    @property
    def _llm_type(self) -> str:  # pragma: no cover - metadata only
        return "cerebras-langchain-chat"

    def _filter_think_text(self, text: str) -> str:
        """Strip <think>...</think> regions that should remain hidden."""
        if not text:
            return ""
        output_chars: List[str] = []
        i = 0
        while i < len(text):
            if not self._inside_think and text.startswith("<think>", i):
                self._inside_think = True
                i += len("<think>")
                continue
            if self._inside_think and text.startswith("</think>", i):
                self._inside_think = False
                i += len("</think>")
                continue
            if not self._inside_think:
                output_chars.append(text[i])
            i += 1
        return "".join(output_chars)

    def _convert_messages(self, messages: List[BaseMessage]) -> List[dict]:
        formatted: List[dict] = []
        for message in messages:
            role = "user"
            if isinstance(message, SystemMessage):
                role = "system"
            elif isinstance(message, AIMessage):
                role = "assistant"
            elif isinstance(message, HumanMessage):
                role = "user"
            content = message.content
            if isinstance(content, list):
                text_fragments: List[str] = []
                for fragment in content:
                    if isinstance(fragment, str):
                        text_fragments.append(fragment)
                    elif isinstance(fragment, dict) and "text" in fragment:
                        text_fragments.append(str(fragment["text"]))
                content = "\n".join(text_fragments)
            formatted.append({"role": role, "content": str(content)})
        return formatted

    def _generate(
        self,
        messages: List[BaseMessage],
        stop: Optional[List[str]] = None,
        run_manager: Optional[CallbackManagerForLLMRun] = None,
        **kwargs: object,
    ) -> ChatResult:
        payload = self._convert_messages(messages)
        _ = stop, kwargs  # stop sequences unsupported currently
        self.last_stream_printed = False
        self._inside_think = False
        stream = None
        chunks: List[str] = []
        try:
            stream = self.client.chat.completions.create(
                messages=payload,
                model=self.config.cerebras_model,
                stream=True,
                max_completion_tokens=self.config.cerebras_max_tokens,
                temperature=self.config.cerebras_temperature,
                top_p=self.config.cerebras_top_p,
            )
            for chunk in stream:
                try:
                    delta = chunk.choices[0].delta
                    piece = getattr(delta, "content", None)
                except (AttributeError, IndexError):
                    piece = None
                if not piece:
                    continue
                filtered = self._filter_think_text(piece)
                if not filtered:
                    continue
                print(filtered, end="", flush=True)
                chunks.append(filtered)
                self.last_stream_printed = True
                if run_manager is not None:
                    run_manager.on_llm_new_token(filtered)
        finally:
            if stream is not None:
                closer = getattr(stream, "close", None)
                if callable(closer):
                    closer()
        if self.last_stream_printed:
            print()
        text = "".join(chunks).strip()
        ai_message = AIMessage(content=text)
        return ChatResult(generations=[ChatGeneration(message=ai_message)])


class ConversationLoop:
    def __init__(self, config: Config) -> None:
        self.config = config
        self.stt = SpeechRecognizer(config)
        self.tts = TextToSpeechEngine(config)
        self.llm = LangChainCerebrasChat(config)
        self.history: List[BaseMessage] = []
        if config.system_instruction:
            self.history.append(SystemMessage(content=config.system_instruction))
        self._running = True

    def stop(self) -> None:
        self._running = False


    # Dynamically delay 
    def run(self) -> None:
        print("Voice chat ready. Say something (or 'quit' to exit).")
        while self._running:
            utterance = self.stt.listen()
            if not utterance:
                continue
            normalized = utterance.lower()
            print(f"You: {utterance}")
            if normalized in self.config.exit_phrases:
                print("Exit phrase detected. Goodbye!")
                break
            human_msg = HumanMessage(content=utterance)
            messages = [*self.history, human_msg]
            try:
                ai_message = self.llm.invoke(messages)
            except Exception as exc:  # pragma: no cover - SDK errors
                print(f"[Cerebras error] {exc}", file=sys.stderr)
                continue
            response_text = self._extract_text(ai_message)
            if not response_text:
                print("Assistant: (no response)")
                continue
            self.history.append(human_msg)
            self.history.append(ai_message)
            if not self.llm.last_stream_printed:
                print(f"Assistant: {response_text}")
            self.tts.speak(response_text)

    @staticmethod
    def _extract_text(message: BaseMessage) -> str:
        content = getattr(message, "content", "")
        if isinstance(content, str):
            return content.strip()
        if isinstance(content, list):
            parts: List[str] = []
            for fragment in content:
                if isinstance(fragment, str):
                    parts.append(fragment)
                elif isinstance(fragment, dict) and "text" in fragment:
                    parts.append(str(fragment["text"]))
            return "\n".join(parts).strip()
        return str(content).strip()


def _install_signal_handlers(loop: ConversationLoop) -> None:
    def _handler(signum, _frame) -> None:
        print(f"\nReceived signal {signum}. Exiting...", file=sys.stderr)
        loop.stop()

    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, _handler)


def main() -> None:
    config = Config()
    config.validate()
    loop = ConversationLoop(config)
    _install_signal_handlers(loop)
    try:
        loop.run()
    except KeyboardInterrupt:
        print("\nInterrupted by user.", file=sys.stderr)
    finally:
        loop.stop()
        time.sleep(0.2)


if __name__ == "__main__":
    main()
