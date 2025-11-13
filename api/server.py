"""Flask API server for Cerebras-powered voice conversation with PDF context.

Endpoints:
    POST /api/upload-pdf     - Upload and process PDF file
    POST /api/start-conversation - Initialize conversation with PDF context
    POST /api/listen         - Capture voice input from microphone
    POST /api/send-message   - Send message to Cerebras and get response
    GET  /api/conversation-history - Get current conversation history
    POST /api/reset          - Reset conversation state
"""

from flask import Flask, request, jsonify, session
from flask_cors import CORS
from flask_socketio import SocketIO, emit, join_room

from werkzeug.utils import secure_filename
import os
import sys
import tempfile
import threading
from typing import Optional, Dict, List
from dotenv import load_dotenv

# Import from speech.py
from speech import (
    Config,
    SpeechRecognizer,
    TextToSpeechEngine,
    LangChainCerebrasChat,
)
from prompt import get_iterative_prompt, get_system_prompt
from langchain_core.messages import SystemMessage, HumanMessage, AIMessage, BaseMessage
from prompts import get_system_prompt, get_iterative_prompt
load_dotenv('.env.local')

VOICE_IO_ENABLED = os.getenv('ENABLE_SERVER_VOICE', 'false').lower() == 'true'

app = Flask(__name__)
app.secret_key = os.getenv('FLASK_SECRET_KEY', 'dev-secret-key-change-in-production')

# Configure session cookies
app.config['SESSION_COOKIE_SAMESITE'] = 'None'
app.config['SESSION_COOKIE_SECURE'] = False  # Set to True in production with HTTPS
app.config['SESSION_COOKIE_HTTPONLY'] = True

# Configure CORS to allow credentials from frontend
allowed_origins_str = os.getenv('ALLOWED_ORIGINS', 'http://localhost:3000,http://localhost:5173,http://127.0.0.1:3000,http://127.0.0.1:5173')

if os.getenv('ALLOW_ALL_ORIGINS', 'false').lower() == 'true':
    allowed_origins = '*'
else:
    allowed_origins = [origin.strip() for origin in allowed_origins_str.split(',')]

# Enable CORS for HTTP endpoints
CORS(app, resources={r"/*": {"origins": allowed_origins}}, supports_credentials=True)

# Initialize SocketIO with CORS support (must be after Flask config)
socketio = SocketIO(
    app,
    cors_allowed_origins=allowed_origins,
    async_mode='threading',
    logger=True,
    engineio_logger=False
)

# Global state (in production, use Redis or similar)
conversations: Dict[str, Dict] = {}
pdf_storage: Dict[str, str] = {}  # Store PDF text by session_id

class ConversationSession:
    """Manages a single conversation session with Cerebras."""
    
    def __init__(self, session_id: str, pdf_text: str = ""):
        self.session_id = session_id
        self.pdf_text = pdf_text
        self.config = Config()
        self.config.validate()
        # self.isfirst = True

        
        # Initialize components
        self.voice_enabled = VOICE_IO_ENABLED
        self.stt: Optional[SpeechRecognizer] = None
        self.tts: Optional[TextToSpeechEngine] = None
        if self.voice_enabled:
            self._initialize_voice_components()
        self.llm = LangChainCerebrasChat(self.config)
        
        # Conversation history
        self.history: List[BaseMessage] = []
        
        # Build system prompt with PDF context
        system_prompt = self._build_system_prompt()
        self.history.append(SystemMessage(content=system_prompt))


    def _build_system_prompt(self) -> str:
        """Build system prompt including PDF context."""
        # if self.isfirst:
        base_prompt = get_system_prompt()
            # self.isfirst = False
        # else:
        #     base_prompt = get_iterative_prompt()


        if self.pdf_text:
            return f"{base_prompt}\n\n=== STUDY MATERIAL ===\n{self.pdf_text}\n\n=== END MATERIAL ===\n\nUse this material to guide your tutoring."
        
        return base_prompt
    
    def _initialize_voice_components(self) -> None:
        """Set up optional speech components."""
        try:
            self.stt = SpeechRecognizer(self.config)
        except Exception as exc:
            self.stt = None
            print(f"[Voice] Failed to initialize speech recognition: {exc}", file=sys.stderr)
        
        try:
            self.tts = TextToSpeechEngine(self.config)
        except Exception as exc:
            self.tts = None
            print(f"[Voice] Failed to initialize text-to-speech: {exc}", file=sys.stderr)
        
        if not self.stt and not self.tts:
            self.voice_enabled = False

    def listen(self) -> Optional[str]:
        """Capture voice input from microphone."""
        if not self.stt:
            raise RuntimeError("Speech recognition is not enabled on this server.")
        return self.stt.listen()
    
    def send_message(self, user_input: str) -> str:
        """Send message to Cerebras and get response."""
        human_msg = HumanMessage(content=user_input)
        
        # Add iterative prompt before user message to guide this turn
        iterative_guidance = get_iterative_prompt()
        guidance_msg = SystemMessage(content=iterative_guidance)
        
        # Build messages: history + iterative guidance + user message
        iter_guide = get_iterative_prompt()
        guidance = SystemMessage(content=iter_guide)
        messages = [*self.history, guidance_msg, guidance, human_msg]

        try:
            ai_message = self.llm.invoke(messages)
            response_text = self._extract_text(ai_message)
            
            if response_text:
                # Only save user message and AI response to history
                # Don't save the iterative guidance (it's added fresh each turn)
                self.history.append(human_msg)
                self.history.append(ai_message)
            
            return response_text
        except Exception as exc:
            print(f"[Cerebras error] {exc}", file=sys.stderr)
            raise

    def speak_async(self, text: str) -> None:
        """Speak text using TTS in a background thread."""
        if not self.tts or not text.strip():
            return
        
        def _speak():
            try:
                self.tts.speak(text)
            except Exception as exc:
                print(f"[Voice] Error during speech synthesis: {exc}", file=sys.stderr)
        
        threading.Thread(target=_speak, daemon=True).start()

    def build_audio_payload(self, text: str) -> Optional[Dict[str, str]]:
        if not self.tts or not text.strip():
            return None
        try:
            result = self.tts.synthesize_to_base64(text)
        except Exception as exc:
            print(f"[Voice] Failed to synthesize audio: {exc}", file=sys.stderr)
            return None
        if not result:
            return None
        audio_b64, mime_type = result
        return {"audioBase64": audio_b64, "audioMimeType": mime_type}
    
    def get_history(self) -> List[Dict]:
        """Get conversation history as JSON-serializable list."""
        history = []
        for msg in self.history:
            if isinstance(msg, SystemMessage):
                continue  # Don't send system messages to frontend
            
            role = 'user' if isinstance(msg, HumanMessage) else 'tutor'
            content = self._extract_text(msg)
            history.append({'role': role, 'content': content})
        
        return history
    
    @staticmethod
    def _extract_text(message: BaseMessage) -> str:
        """Extract text content from message."""
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


# ============= API ENDPOINTS =============

@app.route('/api/health', methods=['GET'])
def health_check():
    """Health check endpoint."""
    return jsonify({'status': 'ok', 'message': 'Cerebras API server running'})


@app.route('/api/upload-pdf', methods=['POST'])
def upload_pdf():
    """Upload and process PDF file."""
    if 'file' not in request.files:
        return jsonify({'error': 'No file provided'}), 400
    
    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': 'No file selected'}), 400
    
    if not file.filename.endswith('.pdf'):
        return jsonify({'error': 'Only PDF files are supported'}), 400
    
    try:
        # Read PDF text (frontend already processed it, so we just receive the text)
        # In a full implementation, you'd process the PDF here
        pdf_text = request.form.get('pdfText', '')
        
        if not pdf_text:
            return jsonify({'error': 'No PDF text provided'}), 400
        
        # Create session ID
        session_id = os.urandom(16).hex()
        
        # Store PDF text in memory (not in cookie - too large!)
        pdf_storage[session_id] = pdf_text
        
        # Only store small metadata in session
        session['session_id'] = session_id
        session['filename'] = secure_filename(file.filename)
        
        print(f"[DEBUG] Session created: {session_id}")
        print(f"[DEBUG] PDF text length: {len(pdf_text)} bytes")
        
        return jsonify({
            'success': True,
            'sessionId': session_id,
            'filename': session['filename'],
            'message': 'PDF processed successfully'
        })
    
    except Exception as e:
        print(f"Error processing PDF: {e}", file=sys.stderr)
        return jsonify({'error': str(e)}), 500


@app.route('/api/start-conversation', methods=['POST'])
def start_conversation():
    """Initialize conversation with PDF context."""
    data = request.get_json() or {}
    session_id = data.get('sessionId') or session.get('session_id')
    
    # Get PDF text from memory storage
    pdf_text = pdf_storage.get(session_id, '')
    
    print(f"[DEBUG] Start conversation - session_id: {session_id}")
    print(f"[DEBUG] PDF text length: {len(pdf_text)} bytes")
    print(f"[DEBUG] PDF storage keys: {list(pdf_storage.keys())}")
    
    if not session_id:
        return jsonify({'error': 'No active session. Upload a PDF first.'}), 400
    
    try:
        # Create conversation session
        conv = ConversationSession(session_id, pdf_text)
        conversations[session_id] = conv
        
        # Generate initial greeting
        initial_message = conv.send_message(
            "Hello! I've uploaded my study material and I'm ready to learn."
        )
        conv.speak_async(initial_message)
        audio_payload = conv.build_audio_payload(initial_message) or {}
        
        response_body = {
            'success': True,
            'message': initial_message,
            'sessionId': session_id
        }
        response_body.update(audio_payload)
        
        return jsonify(response_body)
    
    except Exception as e:
        print(f"Error starting conversation: {e}", file=sys.stderr)
        return jsonify({'error': str(e)}), 500


@app.route('/api/listen', methods=['POST'])
def listen():
    """Capture voice input from microphone."""
    data = request.get_json() or {}
    session_id = data.get('sessionId') or session.get('session_id')
    
    if not session_id or session_id not in conversations:
        return jsonify({'error': 'No active conversation'}), 400
    
    try:
        conv = conversations[session_id]
        if not getattr(conv, "stt", None):
            return jsonify({'error': 'Speech recognition not enabled on server'}), 400
        
        utterance = conv.listen()
        
        if not utterance:
            return jsonify({'success': False, 'message': 'Could not understand audio'})
        
        return jsonify({
            'success': True,
            'text': utterance
        })
    
    except Exception as e:
        print(f"Error listening: {e}", file=sys.stderr)
        return jsonify({'error': str(e)}), 500


@app.route('/api/send-message', methods=['POST'])
def send_message():
    """Send message to Cerebras and get response."""
    data = request.get_json() or {}
    session_id = data.get('sessionId') or session.get('session_id')
    
    if not session_id or session_id not in conversations:
        return jsonify({'error': 'No active conversation'}), 400
    


    user_input = data.get('message', '').strip()
    
    if not user_input:
        return jsonify({'error': 'No message provided'}), 400
    
    try:
        conv = conversations[session_id]
        response = conv.send_message(user_input)
        conv.speak_async(response)
        audio_payload = conv.build_audio_payload(response) or {}
        
        response_body = {
            'success': True,
            'response': response,
            'history': conv.get_history()
        }
        response_body.update(audio_payload)
        
        return jsonify(response_body)
    
    except Exception as e:
        print(f"Error sending message: {e}", file=sys.stderr)
        return jsonify({'error': str(e)}), 500


@app.route('/api/conversation-history', methods=['GET'])
def get_conversation_history():
    """Get current conversation history."""
    # For GET requests, try to get from query params or session
    session_id = request.args.get('sessionId') or session.get('session_id')
    
    if not session_id or session_id not in conversations:
        return jsonify({'history': []})
    
    try:
        conv = conversations[session_id]
        return jsonify({
            'success': True,
            'history': conv.get_history()
        })
    
    except Exception as e:
        print(f"Error getting history: {e}", file=sys.stderr)
        return jsonify({'error': str(e)}), 500


@app.route('/api/reset', methods=['POST'])
def reset_conversation():
    """Reset conversation state."""
    data = request.get_json() or {}
    session_id = data.get('sessionId') or session.get('session_id')
    
    if session_id:
        if session_id in conversations:
            del conversations[session_id]
        if session_id in pdf_storage:
            del pdf_storage[session_id]
    
    session.clear()
    
    return jsonify({
        'success': True,
        'message': 'Conversation reset'
    })


# ============= WEBSOCKET EVENTS =============

@socketio.on('connect')
def handle_connect():
    """Handle client connection."""
    print(f'[WebSocket] Client connected: {request.sid}')
    emit('connected', {'sessionId': request.sid})


@socketio.on('disconnect')
def handle_disconnect():
    """Handle client disconnection."""
    print(f'[WebSocket] Client disconnected: {request.sid}')


@socketio.on('join_session')
def handle_join(data):
    """Join a conversation session."""
    session_id = data.get('sessionId', request.sid)
    join_room(session_id)
    
    print(f'[WebSocket] Client {request.sid} joined session: {session_id}')
    
    # Initialize conversation if needed
    if session_id not in conversations:
        pdf_text = pdf_storage.get(session_id, '')
        try:
            conversations[session_id] = ConversationSession(session_id, pdf_text)
            print(f'[WebSocket] Created new conversation session: {session_id}')
        except Exception as e:
            print(f'[WebSocket] Error creating session: {e}', file=sys.stderr)
            emit('error', {'message': f'Failed to create session: {str(e)}'})
            return
    
    # Send conversation history
    conv = conversations[session_id]
    emit('session_joined', {
        'sessionId': session_id,
        'history': conv.get_history()
    })


@socketio.on('user_message')
def handle_message(data):
    """Handle incoming user message and stream AI response."""
    session_id = data.get('sessionId')
    message = data.get('message', '').strip()
    
    print(f'[WebSocket] Received message from {session_id}: {message[:50]}...')
    
    if not session_id or session_id not in conversations:
        emit('error', {'message': 'No active session. Please join a session first.'})
        return
    
    if not message:
        emit('error', {'message': 'Empty message received'})
        return
    
    conv = conversations[session_id]
    
    # Add user message to history
    human_msg = HumanMessage(content=message)
    messages = [*conv.history, human_msg]
    
    try:
        # Notify client that AI is starting to respond
        emit('ai_start', {})
        
        # Stream response chunks from Cerebras
        stream = conv.llm.client.chat.completions.create(
            messages=conv.llm._convert_messages(messages),
            model=conv.config.cerebras_model,
            stream=True,
            max_completion_tokens=conv.config.cerebras_max_tokens,
            temperature=conv.config.cerebras_temperature,
            top_p=conv.config.cerebras_top_p,
        )
        
        full_response = []
        for chunk in stream:
            try:
                delta = chunk.choices[0].delta
                piece = getattr(delta, "content", None)
                if piece:
                    # Filter out <think> tags
                    filtered = conv.llm._filter_think_text(piece)
                    if filtered:
                        emit('ai_chunk', {'content': filtered})
                        full_response.append(filtered)
            except (AttributeError, IndexError):    
                continue
        
        # Update conversation history
        response_text = ''.join(full_response)
        conv.history.append(human_msg)
        conv.history.append(AIMessage(content=response_text))
        conv.speak_async(response_text)
        audio_payload = conv.build_audio_payload(response_text) or {}

        # Notify client that response is complete
        emit('ai_complete', {
            'fullResponse': response_text,
            'history': conv.get_history(),
            **audio_payload
        })
        
        print(f'[WebSocket] Completed response for {session_id}: {len(response_text)} chars')
        
    except Exception as e:
        print(f'[WebSocket] Error handling message: {e}', file=sys.stderr)
        emit('error', {'message': f'Error generating response: {str(e)}'})


@socketio.on('stop_speaking')
def handle_stop_speaking(data):
    """Handle request to stop AI from speaking (for future implementation)."""
    session_id = data.get('sessionId')
    print(f'[WebSocket] Stop speaking requested for {session_id}')
    # This can be used to interrupt streaming in the future
    emit('speaking_stopped', {})


if __name__ == '__main__':
    port = int(os.getenv('PORT', 8501))
    debug = os.getenv('FLASK_ENV') == 'development'
    
    print(f"Starting Flask-SocketIO server on port {port}...")
    print(f"Make sure CEREBRAS_API_KEY is set in your environment")
    print(f"WebSocket endpoint: ws://localhost:{port}")
    
    socketio.run(app, host='0.0.0.0', port=port, debug=debug, allow_unsafe_werkzeug=True)
