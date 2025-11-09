"""
Voice-driven interface for chatting with Cerebras-hosted LLMs.

Requires the following third-party packages:
    pip install speechrecognition sounddevice scipy pyttsx3 cerebras-cloud-sdk langchain-core langchain python-dotenv

Environment variables:
    CEREBRAS_API_KEY        -> Required. Key from cerebras.ai
    CEREBRAS_MODEL          -> Optional. Defaults to "llama3.1-8b"
    CEREBRAS_BASE_URL       -> Optional. Override Cerebras endpoint
    CEREBRAS_MAX_TOKENS     -> Optional. Max completion tokens (default 500)
    CEREBRAS_TEMPERATURE    -> Optional. Sampling temperature (default 0.6)
    CEREBRAS_TOP_P          -> Optional. Top-p sampling cutoff (default 0.95)
    SYSTEM_PROMPT           -> Optional system instruction for the assistant
    EXIT_PHRASES            -> Optional comma-separated exit triggers
    INITIAL_PROMPT          -> Optional greeting/intro message from AI
    SILENCE_THRESHOLD       -> Seconds of silence before responding (default 3.0)
    SESSION_MODE            -> quick_review, deep_dive, practice, exam_prep, exploratory (default: exploratory)

Usage:
    export CEREBRAS_API_KEY="..."
    export SESSION_MODE=deep_dive
    python speech.py
"""

from __future__ import annotations

import os
import signal
import sys
import time
import subprocess
from dataclasses import dataclass, field
from typing import List, Optional, Sequence, Tuple

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
except ImportError as exc:
    sr = None  # type: ignore
    _SR_IMPORT_ERROR = exc
else:
    _SR_IMPORT_ERROR = None

# Try PyAudio first, fall back to SoundDevice
try:
    import pyaudio  # noqa
    _HAS_PYAUDIO = True
except ImportError:
    _HAS_PYAUDIO = False
    try:
        import sounddevice as sd
        import scipy.io.wavfile as wavfile
        import numpy as np
        _HAS_SOUNDDEVICE = True
        print("⚠️ PyAudio not found, using SoundDevice backend for microphone input.")
    except ImportError as exc:
        _HAS_SOUNDDEVICE = False
        _SOUNDDEVICE_IMPORT_ERROR = exc

try:
    import pyttsx3
except ImportError as exc:
    pyttsx3 = None  # type: ignore
    _TTS_ENGINE_IMPORT_ERROR = exc
else:
    _TTS_ENGINE_IMPORT_ERROR = None

try:
    from cerebras.cloud.sdk import Cerebras
except ImportError as exc:
    Cerebras = None  # type: ignore
    _CEREBRAS_IMPORT_ERROR = exc
else:
    _CEREBRAS_IMPORT_ERROR = None


# ========== DEFAULT CONSTANTS ==========
DEFAULT_EXIT_PHRASES: Tuple[str, ...] = ("quit", "exit", "stop", "goodbye", "good bye", "that's all")
DEFAULT_CEREBRAS_MODEL = "qwen-3-32b"
DEFAULT_MAX_TOKENS = 300  # Reduced from 500 to keep responses shorter
DEFAULT_TEMPERATURE = 0.6
DEFAULT_TOP_P = 0.95
DEFAULT_SILENCE_THRESHOLD = 3.0
SUMMARY_INTERVAL = 5  # Summarize every 5 exchanges


# ========== ENV + PROMPT HELPERS ==========
load_dotenv('.env.local')


def _comma_env(name: str, fallback: Sequence[str]) -> Tuple[str, ...]:
    raw = os.getenv(name)
    if not raw:
        return tuple(fallback)
    cleaned = tuple(filter(None, (part.strip().lower() for part in raw.split(","))))
    return cleaned or tuple(fallback)


def _get_system_prompt(session_mode: str) -> str:
    """Return enhanced system prompt with all improvements."""
    custom = os.getenv("SYSTEM_PROMPT")
    if custom:
        return custom
    
    # Session-specific guidance
    mode_instructions = {
        "quick_review": "Focus on brief, high-level summaries. Hit key points quickly.",
        "deep_dive": "Provide comprehensive, detailed explanations. Go deep into theory and context.",
        "practice": "Focus on problems, exercises, and hands-on application. Guide through solutions.",
        "exam_prep": "Emphasize key concepts, common pitfalls, and test-taking strategies.",
        "exploratory": "Follow the student's curiosity. Allow tangential discussions and connections."
    }
    
    mode_instruction = mode_instructions.get(session_mode, mode_instructions["exploratory"])
    
    return f"""You are an adaptive educational AI tutor helping students learn. The user is ALWAYS the Student.

SESSION MODE: {session_mode.upper()}
{mode_instruction}

=== ROLE SELECTION ===
Choose your role dynamically based on each question:

**[Expert] (Professor)**: Use for:
- Deep dives and first-principles explanations
- 'Why' questions about theory, definitions, historical context
- Introducing new concepts and foundational knowledge
- Explaining complex systems and relationships
- Speaking authoritatively but accessibly

**[TA] (Tutor)**: Use for:
- Step-by-step walkthroughs and problem-solving
- 'How' questions about application and process
- Practice problems and exercises
- Socratic method and guided discovery
- Tips, tricks, and exam strategies
- Speaking collaboratively and encouragingly

ALWAYS start your response with [Expert] or [TA] to indicate your role.

=== ADAPTIVE TEACHING ===
Track and adapt to the student's learning:
- Monitor which topics they grasp quickly vs. struggle with
- Adjust explanation complexity based on their responses
- Reference previous questions to build conceptual connections
- Note their confidence level from tone and questions
- Celebrate progress when they demonstrate understanding

Difficulty Levels (adapt automatically):
1. Struggling: Simplify, use more analogies, break into smaller steps
2. Comfortable: Standard explanations with examples
3. Advanced: Challenge with deeper questions, introduce edge cases

=== METACOGNITIVE PROMPTS ===
Every 3-4 exchanges, include ONE of these to promote deeper learning:
- "How would you explain this concept to a friend?"
- "What connections do you see with [previous topic]?"
- "What's still unclear or confusing to you?"
- "On a scale of 1-10, how confident are you with this?"
- "Can you predict what would happen if we changed [variable]?"
- "What surprised you most about this concept?"

=== TEACHING VARIETY ===
Use diverse approaches to maintain engagement:
- Real-world analogies and examples
- Feynman technique: explain in simple terms
- Ask student to predict outcomes before explaining
- Present counter-examples to test understanding
- Visual descriptions when helpful ("imagine a graph with...")
- Historical context or interesting applications

=== EMOTIONAL INTELLIGENCE ===
Detect and respond to struggle signals:
- Repeated questions on same topic → Try different explanation approach
- Expressions of confusion → "This is tricky! Let's break it down differently"
- Frustration → Offer encouragement and suggest a break if needed
- Quick understanding → "Great! Ready for something more challenging?"
- Uncertainty → "No worries, let's clarify that piece by piece"

=== TOPIC FLOW ===
Guide natural progression:
- After explaining a concept, suggest: "Now that you understand X, want to explore Y?"
- Connect to related topics: "This relates to [topic]. Should we discuss that?"
- Summarize key points before major transitions
- Ask "What would you like to focus on next?"

=== CONVERSATION MEMORY ===
Maintain context throughout the session:
- Remember topics already covered
- Build on previous examples and analogies
- Track questions asked and answered
- Note which explanations worked well
- Reference earlier confusions that were cleared up

=== RESPONSE CONSTRAINTS ===
- Keep responses under 100 words (~500 tokens max)
- Be conversational and natural, not lecture-like
- Avoid emojis and excessive formatting
- Speak as if having a real conversation
- Use "you" to address the student directly

=== EXAMPLES ===

Student: "What is photosynthesis?"
Response: "[Expert] Photosynthesis is how plants convert sunlight into chemical energy. Think of it like a solar panel plus a battery. Light hits chlorophyll, splits water molecules, and builds glucose - plant fuel! Two main stages: light reactions (capture energy) and Calvin cycle (build sugars). Want to dive into either stage?"

Student: "Can you help me solve 2x + 5 = 13?"
Response: "[TA] Perfect practice problem! Let's work through it together. First question: what's our goal here - what are we solving for? And what's the first operation you'd want to undo to isolate x?"

Student: "I'm confused about this"
Response: "[TA] No problem, let's approach it differently. Think of it this way: [simpler analogy]. Does that make more sense, or should I explain the specific part that's confusing?"

Remember: You're not just answering questions - you're building understanding, confidence, and curiosity."""


def _get_initial_prompt(session_mode: str) -> str:
    """Get session-appropriate initial prompt."""
    custom = os.getenv("INITIAL_PROMPT")
    if custom:
        return custom
    
    prompts = {
        "quick_review": "Hi! I'm your AI tutor. I see you're in quick review mode - I'll keep things concise and hit the key points. What topic should we review?",
        "deep_dive": "Hello! I'm your AI tutor in deep dive mode - we'll explore concepts thoroughly and dig into the details. What would you like to understand deeply today?",
        "practice": "Hey! I'm your AI tutor in practice mode - I'll focus on problems and hands-on application. What would you like to practice?",
        "exam_prep": "Hi! I'm your AI tutor in exam prep mode - I'll emphasize key concepts and help you prepare effectively. What exam or topic are you studying for?",
        "exploratory": "Hello! I'm your adaptive AI tutor. I'll switch between being an Expert professor for deep explanations, and a TA tutor for practice and guidance. What are you curious about today?"
    }
    
    return prompts.get(session_mode, prompts["exploratory"])


# ========== CONFIGURATION ==========
@dataclass
class Config:
    cerebras_api_key: str = field(default_factory=lambda: os.getenv("CEREBRAS_API_KEY", ""))
    cerebras_model: str = field(default_factory=lambda: os.getenv("CEREBRAS_MODEL", DEFAULT_CEREBRAS_MODEL))
    cerebras_base_url: str = field(default_factory=lambda: os.getenv("CEREBRAS_BASE_URL", "").strip())
    session_mode: str = field(default_factory=lambda: os.getenv("SESSION_MODE", "exploratory"))
    system_instruction: str = field(default_factory=lambda: _get_system_prompt(os.getenv("SESSION_MODE", "exploratory")))
    initial_prompt: str = field(default_factory=lambda: _get_initial_prompt(os.getenv("SESSION_MODE", "exploratory")))
    cerebras_max_tokens: int = field(default_factory=lambda: int(os.getenv("CEREBRAS_MAX_TOKENS", str(DEFAULT_MAX_TOKENS))))
    cerebras_temperature: float = field(default_factory=lambda: float(os.getenv("CEREBRAS_TEMPERATURE", str(DEFAULT_TEMPERATURE))))
    cerebras_top_p: float = field(default_factory=lambda: float(os.getenv("CEREBRAS_TOP_P", str(DEFAULT_TOP_P))))
    exit_phrases: Tuple[str, ...] = field(default_factory=lambda: _comma_env("EXIT_PHRASES", DEFAULT_EXIT_PHRASES))
    energy_threshold: int = field(default_factory=lambda: int(os.getenv("ENERGY_THRESHOLD", "300")))
    silence_threshold: float = field(default_factory=lambda: float(os.getenv("SILENCE_THRESHOLD", str(DEFAULT_SILENCE_THRESHOLD))))
    phrase_time_limit: Optional[int] = field(default_factory=lambda: int(os.getenv("PHRASE_TIME_LIMIT", "30")) if os.getenv("PHRASE_TIME_LIMIT") else 30)

    def validate(self) -> None:
        if not self.cerebras_api_key:
            raise SystemExit("Missing CEREBRAS_API_KEY environment variable.")
        if Cerebras is None:
            raise SystemExit(f"cerebras-cloud-sdk is not installed. Details: {_CEREBRAS_IMPORT_ERROR}")
        if BaseChatModel is None:
            raise SystemExit(f"LangChain core packages are missing. Details: {_LANGCHAIN_IMPORT_ERROR}")
        if sr is None:
            raise SystemExit(f"speechrecognition is not installed. Details: {_SR_IMPORT_ERROR}")
        if not _HAS_PYAUDIO and not _HAS_SOUNDDEVICE:
            raise SystemExit("Neither PyAudio nor SoundDevice is installed. Install one: pip install sounddevice scipy")
        if pyttsx3 is None:
            raise SystemExit(f"pyttsx3 is not installed. Details: {_TTS_ENGINE_IMPORT_ERROR}")


# ========== SPEECH RECOGNITION WITH SILENCE DETECTION ==========
class SpeechRecognizer:
    def __init__(self, config: Config) -> None:
        self.recognizer = sr.Recognizer()
        self.recognizer.energy_threshold = config.energy_threshold
        self.recognizer.pause_threshold = config.silence_threshold
        self.phrase_time_limit = config.phrase_time_limit
        self.use_pyaudio = _HAS_PYAUDIO

    def listen(self) -> Optional[str]:
        if self.use_pyaudio:
            return self._listen_pyaudio()
        else:
            return self._listen_sounddevice()

    def _listen_pyaudio(self) -> Optional[str]:
        """Use PyAudio backend (default)."""
        try:
            with sr.Microphone() as source:
                print("🎤 Listening...")
                self.recognizer.adjust_for_ambient_noise(source, duration=1)
                audio = self.recognizer.listen(source, phrase_time_limit=self.phrase_time_limit)
            text = self.recognizer.recognize_google(audio)
            return text.strip()
        except sr.UnknownValueError:
            print("Transcription: (could not understand audio)")
            return None
        except sr.RequestError as exc:
            print(f"Speech recognition request failed: {exc}", file=sys.stderr)
            return None

    def _listen_sounddevice(self) -> Optional[str]:
        """Use SoundDevice backend as fallback with silence detection."""
        try:
            import tempfile
            
            print("🎤 Listening...")
            
            duration = self.phrase_time_limit if self.phrase_time_limit else 30
            sample_rate = 16000
            
            audio_data = sd.rec(
                int(duration * sample_rate),
                samplerate=sample_rate,
                channels=1,
                dtype=np.int16
            )
            sd.wait()
            
            temp_file = tempfile.NamedTemporaryFile(delete=False, suffix='.wav')
            wavfile.write(temp_file.name, sample_rate, audio_data)
            
            with sr.AudioFile(temp_file.name) as source:
                audio = self.recognizer.record(source)
            
            os.unlink(temp_file.name)
            
            text = self.recognizer.recognize_google(audio)
            return text.strip()
            
        except sr.UnknownValueError:
            print("Transcription: (could not understand audio)")
            return None
        except sr.RequestError as exc:
            print(f"Speech recognition request failed: {exc}", file=sys.stderr)
            return None
        except Exception as exc:
            print(f"SoundDevice recording failed: {exc}", file=sys.stderr)
            return None


# ========== TEXT TO SPEECH ==========
# ========== TEXT TO SPEECH (Robust Version) ==========
class TextToSpeechEngine:
    def __init__(self) -> None:
        self.use_system_say = False
        self.engine = None
        self._init_engine()

    def _init_engine(self):
        """Initialize or reinitialize TTS engine."""
        try:
            import pyttsx3
            self.engine = pyttsx3.init()
            self.engine.setProperty('rate', 175)
            self.engine.setProperty('volume', 1.0)
            print("✓ Text-to-speech initialized (pyttsx3)")
        except Exception as e:
            print(f"⚠️ pyttsx3 failed: {e}")
            if sys.platform == 'darwin':
                print("→ Falling back to macOS 'say' command")
                self.use_system_say = True
            else:
                print("⚠️ No TTS available")

    def speak(self, text: str) -> None:
        if not text:
            return

        print(f"[DEBUG] Speaking: {text[:60]}...")  # Preview first 60 chars

        try:
            if self.use_system_say:
                subprocess.run(['say', text], check=False)
                return

            # Some versions of pyttsx3 require reinitialization each call on macOS
            if sys.platform == 'darwin':
                self._init_engine()

            if self.engine:
                self.engine.say(text)
                self.engine.runAndWait()
                time.sleep(0.25)  # slight buffer between responses
            else:
                print("⚠️ No TTS engine available")

        except Exception as e:
            print(f"⚠️ TTS error: {e}")
            # Attempt fallback on macOS
            if sys.platform == 'darwin':
                try:
                    subprocess.run(['say', text], check=False)
                except Exception as e2:
                    print(f"⚠️ macOS 'say' fallback failed: {e2}")



# ========== LANGCHAIN-CEREBRAS CHAT MODEL ==========
class LangChainCerebrasChat(BaseChatModel):
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
    def _llm_type(self) -> str:
        return "cerebras-langchain-chat"

    def _filter_think_text(self, text: str) -> str:
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
        _ = stop, kwargs
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


# ========== CONVERSATION LOOP ==========
class ConversationLoop:
    def __init__(self, config: Config) -> None:
        self.config = config
        self.stt = SpeechRecognizer(config)
        self.tts = TextToSpeechEngine()
        self.llm = LangChainCerebrasChat(config)
        self.history: List[BaseMessage] = []
        if config.system_instruction:
            self.history.append(SystemMessage(content=config.system_instruction))
        self._running = True
        self.exchange_count = 0
        self.topics_covered: List[str] = []

    def stop(self) -> None:
        self._running = False

    def run(self) -> None:
        print("🎧 Voice chat ready.")
        print(f"📚 Session Mode: {self.config.session_mode.upper().replace('_', ' ')}")
        print(f"⏱️  Silence threshold: {self.config.silence_threshold} seconds")
        print("💡 The AI adapts between Expert (professor) and TA (tutor) based on your needs.\n")
        
        # Give initial prompt
        if self.config.initial_prompt:
            print(f"AI: {self.config.initial_prompt}\n")
            self.tts.speak(self.config.initial_prompt)
        
        while self._running:
            utterance = self.stt.listen()
            if not utterance:
                continue
            normalized = utterance.lower()
            print(f"\nStudent (you): {utterance}")
            
            if normalized in self.config.exit_phrases:
                self._say_goodbye()
                break
            
            human_msg = HumanMessage(content=utterance)
            messages = [*self.history, human_msg]
            
            try:
                ai_message = self.llm.invoke(messages)
            except Exception as exc:
                print(f"[Cerebras error] {exc}", file=sys.stderr)
                continue
            
            response_text = self._extract_text(ai_message)
            if not response_text:
                print("Assistant: (no response)")
                continue
            
            # Extract role and clean response
            role_label, clean_response = self._parse_role_response(response_text)
            
            self.history.append(human_msg)
            self.history.append(ai_message)
            self.exchange_count += 1
            
            if not self.llm.last_stream_printed:
                print(f"\n{role_label}: {clean_response}")
            
            self.tts.speak(clean_response)
            
            # Periodic summary
            if self.exchange_count % SUMMARY_INTERVAL == 0:
                self._maybe_offer_summary()

    def _say_goodbye(self) -> None:
        """Provide a helpful closing message."""
        farewell = f"Great session! We covered {self.exchange_count} topics together. Keep practicing and feel free to come back anytime. Good luck!"
        print(f"\n{farewell}")
        self.tts.speak(farewell)

    def _maybe_offer_summary(self) -> None:
        """Optionally summarize the session so far."""
        summary_msg = HumanMessage(content="[INTERNAL: Briefly summarize our session so far in 1-2 sentences for the student]")
        messages = [*self.history, summary_msg]
        
        try:
            summary_response = self.llm.invoke(messages)
            summary_text = self._extract_text(summary_response)
            _, clean_summary = self._parse_role_response(summary_text)
            
            print(f"\n📊 Session Summary: {clean_summary}\n")
        except Exception:
            pass  # Skip summary if error

    def _parse_role_response(self, text: str) -> Tuple[str, str]:
        """Extract role tag and return (role_label, clean_text)."""
        text = text.strip()
        
        if text.startswith("[Expert]"):
            return "🎓 Expert", text[8:].strip()
        elif text.startswith("[TA]"):
            return "👨‍🏫 TA", text[4:].strip()
        else:
            return "🤖 Assistant", text

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


# ========== SIGNAL HANDLERS + MAIN ==========
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