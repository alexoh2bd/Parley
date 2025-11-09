import React, { useState, useRef, useEffect } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Card } from './ui/card';
import { Mic, MicOff, Send, Settings, Menu, X, MessageSquare, Zap, Volume2, User } from 'lucide-react';
import globeImage from '../assets/parley.png';
import { io, Socket } from 'socket.io-client';

interface Message {
  id: string;
  text: string;
  sender: 'user' | 'ai';
  timestamp: Date;
  audioUrl?: string;
}

export function ResponsiveAIAssistant() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [showSidebar, setShowSidebar] = useState(false);
  const [recognition, setRecognition] = useState<SpeechRecognition | null>(null);
  const [socket, setSocket] = useState<Socket | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const [sessionId, setSessionId] = useState<string>('');
  const sessionIdRef = useRef<string>('');
  const [isConnected, setIsConnected] = useState(false);
  const [currentAIMessage, setCurrentAIMessage] = useState<string>('');
  const [isAIResponding, setIsAIResponding] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const audioQueueRef = useRef<string[]>([]);
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);

  const [conversationMode, setConversationMode] = useState(true);
  const [audioMode, setAudioMode] = useState(false); // Enable/disable TTS
  const audioModeRef = useRef(audioMode);
  const [interimTranscript, setInterimTranscript] = useState('');
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const isRecognitionRunningRef = useRef(false);
  const lastTranscriptRef = useRef<string>('');
  const micEnabledRef = useRef(false);
  const stopCurrentAudio = () => {
    if (currentAudioRef.current) {
      try {
        currentAudioRef.current.pause();
      } catch (err) {
        console.error('[Audio] Failed to pause playback:', err);
      }
      currentAudioRef.current = null;
    }
    setIsSpeaking(false);
  };

  const playNextAudio = () => {
    if (!audioModeRef.current) {
      return;
    }
    if (currentAudioRef.current) {
      return;
    }
    const nextUrl = audioQueueRef.current.shift();
    if (!nextUrl) {
      setIsSpeaking(false);
      return;
    }
    const audio = new Audio(nextUrl);
    currentAudioRef.current = audio;
    const handleComplete = () => {
      if (currentAudioRef.current === audio) {
        currentAudioRef.current = null;
      }
      if (audioQueueRef.current.length === 0) {
        setIsSpeaking(false);
      }
      playNextAudio();
    };
    audio.onended = handleComplete;
    audio.onerror = (err) => {
      console.error('[Audio] Playback error:', err);
      handleComplete();
    };
    audio.play()
      .then(() => setIsSpeaking(true))
      .catch((err) => {
        console.error('[Audio] Failed to start playback:', err);
        handleComplete();
      });
  };

  const enqueueAudio = (url: string) => {
    if (!url) return;
    audioQueueRef.current.push(url);
    if (audioModeRef.current) {
      playNextAudio();
    }
  };

  const buildAudioUrl = (audioBase64?: string, mimeType?: string) => {
    if (!audioBase64) return undefined;
    return `data:${mimeType || 'audio/mpeg'};base64,${audioBase64}`;
  };

  useEffect(() => {
    audioModeRef.current = audioMode;
    if (!audioMode) {
      audioQueueRef.current = [];
      stopCurrentAudio();
    } else {
      playNextAudio();
    }
  }, [audioMode]);

  useEffect(() => {
    return () => {
      audioQueueRef.current = [];
      stopCurrentAudio();
    };
  }, []);

  useEffect(() => {
    // Initialize speech recognition
    if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      const recognitionInstance = new SpeechRecognition();
      recognitionInstance.continuous = true;  // ✅ Keep listening
      recognitionInstance.interimResults = true;  // ✅ Show live transcription
      recognitionInstance.lang = 'en-US';

      recognitionInstance.onresult = (event) => {
        let interimText = '';
        let finalText = '';
        
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const transcript = event.results[i][0].transcript;
          
          if (event.results[i].isFinal) {
            finalText += transcript;
          } else {
            interimText += transcript;
          }
        }
        
        // Store the latest transcript (interim or final)
        const currentText = finalText || interimText;
        if (currentText) {
          lastTranscriptRef.current = currentText;
          setInterimTranscript(currentText);
          console.log('[Speech] 🎤 Current:', currentText);
        }
        
        // If we get a final result, send it immediately
        if (finalText && conversationMode) {
          console.log('[Speech] ✅ Final result - sending:', finalText);
          handleSendMessage(finalText);
          setInterimTranscript('');
          lastTranscriptRef.current = '';
        }
      };
      let silenceTimer: NodeJS.Timeout | null = null;

      recognitionInstance.onspeechend = () => {
        console.log('[Speech] 🛑 Speech ended');
        
        // Send accumulated text after short delay (in case final result comes)
        silenceTimer = setTimeout(() => {
          const textToSend = lastTranscriptRef.current.trim();
          
          if (textToSend && conversationMode) {
            console.log('[Speech] ✅ Sending on speechend:', textToSend);
            handleSendMessage(textToSend);
            setInterimTranscript('');
            lastTranscriptRef.current = '';
          }
        }, 500); // Wait 100ms for potential final result
      };

      recognitionInstance.onspeechstart = () => {
        console.log('[Speech] 🎙️ Speech started');
        
        // Clear silence timer and reset for new utterance
        if (silenceTimer) {
          clearTimeout(silenceTimer);
        }
        lastTranscriptRef.current = '';
      };
      recognitionInstance.onerror = (event) => {
        console.error('[Speech] Error:', event.error);
        
        if (event.error === 'no-speech') {
          // No speech detected - restart
          if (conversationMode) {
            setTimeout(() => recognition?.start(), 1000);
          }
        } else if (event.error === 'aborted') {
          // Aborted - restart if in conversation mode
          if (conversationMode) {
            setTimeout(() => recognition?.start(), 500);
          }
        } else {
          // Other errors - stop conversation mode
          setConversationMode(false);
          setIsListening(false);
        }
      };

      recognitionInstance.onend = () => {
        console.log('[Speech] Recognition ended');
        isRecognitionRunningRef.current = false;
        
        // Recognition ended - restart if in conversation mode
        if (conversationMode && micEnabledRef.current && !isAIResponding) {
          setTimeout(() => {
            if (!isRecognitionRunningRef.current) {
              try {
                recognition?.start();
                isRecognitionRunningRef.current = true;
              } catch (e) {
                console.error('[Speech] Failed to restart:', e);
              }
            }
          }, 100);
        } else {
          setIsListening(false);
        }
      };

      setRecognition(recognitionInstance);
    }

    // Initialize WebSocket connection
    const newSocket = io('http://localhost:8501', {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: 5
    });

    newSocket.on('connect', () => {
      console.log('[WebSocket] ✅ Connected to server');
      setIsConnected(true);
    });

    newSocket.on('connected', (data) => {
      console.log('[WebSocket] ✅ Received session ID:', data.sessionId);
      setSessionId(data.sessionId);
      // Join the session
      console.log('[WebSocket] 📤 Joining session:', data.sessionId);
      newSocket.emit('join_session', { sessionId: data.sessionId });
    });

    newSocket.on('session_joined', (data) => {
      console.log('[WebSocket] ✅ Joined session:', data.sessionId);
      console.log('[WebSocket] 🎯 Ready to send/receive messages');
      
      // Mark as fully connected and ready
      setIsConnected(true);
      sessionIdRef.current = data.sessionId;
      
      // Load conversation history if any
      if (data.history && data.history.length > 0) {
        console.log('[WebSocket] 📜 Loading history:', data.history.length, 'messages');
        const loadedMessages: Message[] = data.history.map((msg: any, idx: number) => ({
          id: `history-${idx}`,
          text: msg.content,
          sender: msg.role === 'user' ? 'user' : 'ai',
          timestamp: new Date()
        }));
        setMessages(loadedMessages);
      }
    });

    newSocket.on('ai_start', () => {
      console.log('[WebSocket] AI started responding');
      setIsAIResponding(true);
      setCurrentAIMessage('');
      
    });

    newSocket.on('ai_chunk', (data) => {
      console.log('[WebSocket] Received chunk:', data.content);
      setCurrentAIMessage(prev => prev + data.content);
    });

    newSocket.on('ai_complete', (data) => {
      console.log('[WebSocket] AI response complete');
      setIsAIResponding(false);
      
      const audioUrl = buildAudioUrl(data.audioBase64, data.audioMimeType);
      const aiMessage: Message = {
        id: Date.now().toString(),
        text: data.fullResponse,
        sender: 'ai',
        timestamp: new Date(),
        audioUrl
      };
      setMessages(prev => [...prev, aiMessage]);
      setCurrentAIMessage('');
      if (audioUrl && audioMode) {
        enqueueAudio(audioUrl);
      }
      
      // Resume listening after AI finishes
      if (conversationMode && recognition && micEnabledRef.current) {
        // In audio mode, wait longer for TTS to complete
        const delay = audioMode ? 1500 : 500;
        console.log(`[Audio] Resuming listening in ${delay}ms`);
        
        setTimeout(() => {
          if (!isRecognitionRunningRef.current) {
            try {
              recognition.start();
              isRecognitionRunningRef.current = true;
              setIsListening(true);
            } catch (e) {
              console.error('[Speech] Failed to restart:', e);
              console.error('[Audio] Failed to restart recognition:', e);
            }
          }
        }, delay);
      }
    });

    newSocket.on('error', (data) => {
      console.error('[WebSocket] Error:', data.message);
      alert(`Error: ${data.message}`);
      setIsAIResponding(false);
    });

    newSocket.on('disconnect', () => {
      console.log('[WebSocket] Disconnected from server');
      setIsConnected(false);
    });

    setSocket(newSocket);
    socketRef.current = newSocket;

    return () => {
      newSocket.close();
    };
  }, []);

  useEffect(() => {
    // Only auto-scroll if user is near the bottom (within 100px)
    const container = messagesContainerRef.current;
    if (container) {
      const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 100;
      
      if (isNearBottom) {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      }
    }
  }, [messages, currentAIMessage]);

  const toggleConversationMode = () => {
    if (!recognition) {
      alert('Speech recognition not supported');
      return;
    }
    
    if (conversationMode) {
      // Stop conversation mode
      recognition.stop();
      isRecognitionRunningRef.current = false;
      setConversationMode(false);
      setAudioMode(false); // Also disable audio
      setIsListening(false);
      micEnabledRef.current = false;
    } else {
      // Start conversation mode
      if (!isRecognitionRunningRef.current) {
        try {
          recognition.start();
          isRecognitionRunningRef.current = true;
          setConversationMode(true);
          setAudioMode(true); // Auto-enable audio for full voice conversation
          setIsListening(true);
          micEnabledRef.current = true;
        } catch (e) {
          console.error('[Speech] Failed to start conversation mode:', e);
        }
      }
    }
  };

  const handleSendMessage = (messageText?: string) => {
    const textToSend = messageText || inputText;
    
    // Use refs for immediate access
    const activeSocket = socketRef.current || socket;
    const activeSessionId = sessionIdRef.current || sessionId;
    
    console.log('[Message] Attempting to send:', {
      text: textToSend,
      hasSocket: !!activeSocket,
      hasSessionId: !!activeSessionId,
      isConnected: isConnected
    });
    
    if (!textToSend.trim() || !activeSocket || !activeSessionId) {
      console.error('[Message] ❌ Cannot send:', {
        hasText: !!textToSend.trim(),
        hasSocket: !!activeSocket,
        hasSessionId: !!activeSessionId
      });
      
      if (!activeSocket || !activeSessionId) {
        alert('Not connected to server. Please wait...');
      }
      return;
    }

    console.log('[Message] Sending:', textToSend);

    const userMessage: Message = {
      id: Date.now().toString(),
      text: textToSend,
      sender: 'user',
      timestamp: new Date()
    };

    setMessages(prev => [...prev, userMessage]);
    setShowChat(true);

    // Send message via WebSocket
    console.log('[WebSocket] 📤 Emitting user_message:', {
      sessionId: activeSessionId,
      message: textToSend
    });
    activeSocket.emit('user_message', {
      sessionId: activeSessionId,
      message: textToSend
    });

    setInputText('');
  };

  const handleVoiceInput = () => {
    if (!recognition) {
      alert('Speech recognition is not supported in your browser.');
      return;
    }

    if (isListening) {
      recognition.stop();
      isRecognitionRunningRef.current = false;
      setIsListening(false);
      micEnabledRef.current = false;
    } else {
      if (!isRecognitionRunningRef.current) {
        try {
          recognition.start();
          isRecognitionRunningRef.current = true;
          setIsListening(true);
          micEnabledRef.current = true;
        } catch (e) {
          console.error('[Speech] Failed to start:', e);
        }
      }
    }
  };
  

  const handleSpeak = (message: Message) => {
    if (!message.audioUrl) {
      alert('Audio is not available for this response yet.');
      return;
    }
    const audio = new Audio(message.audioUrl);
    audio.play().catch((err) => console.error('[Audio] Manual playback failed:', err));
  };
  

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  return (
      <div className="h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-neutral-900 relative overflow-hidden">
        {/* Conversation Mode Indicator */}
        {conversationMode && (
          <div className="fixed top-4 right-4 z-50">
            <div className="bg-green-500/20 border border-green-400 rounded-full px-4 py-2 flex items-center gap-2 backdrop-blur-lg">
            <div className="w-3 h-3 bg-green-400 rounded-full animate-pulse"></div>
            <span className="text-green-200 text-sm font-medium">Conversation Mode Active</span>
          </div>
          {/* Audio Mode Indicator */}
          {audioMode && (
            <div className="bg-blue-500/20 border border-blue-400 rounded-full px-4 py-2 flex items-center gap-2 backdrop-blur-lg">
              <Volume2 className="w-3 h-3 text-blue-400" />
              <span className="text-blue-200 text-sm font-medium">Audio Output Enabled</span>
            </div>
          )}
        </div>
      )}
      
      {/* Background Effects */}
      <div className="absolute inset-0 bg-gradient-to-br from-gray-600/20 via-neutral-500/20 to-gray-700/20"></div>
      <div className="absolute top-20 left-10 w-32 h-32 bg-gray-400/10 rounded-full blur-xl"></div>
      <div className="absolute bottom-20 right-10 w-40 h-40 bg-neutral-400/10 rounded-full blur-xl"></div>
      <div className="absolute top-1/2 left-1/4 w-24 h-24 bg-gray-300/10 rounded-full blur-lg"></div>

      {/* Mobile Sidebar Overlay */}
      {showSidebar && (
        <div className="fixed inset-0 bg-black/50 z-40 lg:hidden" onClick={() => setShowSidebar(false)}>
          <div className="absolute right-0 top-0 h-full w-80 bg-gray-900/95 backdrop-blur-lg border-l border-gray-700" onClick={(e) => e.stopPropagation()}>
            <div className="p-6">
              <div className="flex items-center justify-between mb-8">
                <h3 className="text-white text-lg">Menu</h3>
                <Button 
                  variant="ghost" 
                  size="sm" 
                  onClick={() => setShowSidebar(false)}
                  className="text-white hover:bg-gray-800"
                >
                  <X className="w-5 h-5" />
                </Button>
              </div>
              
              <div className="space-y-4">
                <Button variant="ghost" className="w-full justify-start text-white hover:bg-gray-800">
                  <MessageSquare className="w-4 h-4 mr-3" />
                  Chat History
                </Button>
                <Button variant="ghost" className="w-full justify-start text-white hover:bg-gray-800">
                  <Zap className="w-4 h-4 mr-3" />
                  Quick Actions
                </Button>
                <Button variant="ghost" className="w-full justify-start text-white hover:bg-gray-800">
                  <Settings className="w-4 h-4 mr-3" />
                  Settings
                </Button>
                <Button variant="ghost" className="w-full justify-start text-white hover:bg-gray-800">
                  <User className="w-4 h-4 mr-3" />
                  Profile
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Desktop Sidebar */}
      <div className="hidden lg:block fixed left-0 top-0 h-full w-64 bg-gray-900/30 backdrop-blur-lg border-r border-gray-700/50 z-30">
        <div className="p-6">
          <div className="mb-8">
            <h2 className="text-white text-xl mb-2">AI Assistant</h2>
            <p className="text-gray-300 text-sm">Your intelligent companion</p>
          </div>
          
          <div className="space-y-3">
            <Button variant="ghost" className="w-full justify-start text-white hover:bg-gray-800/50">
              <MessageSquare className="w-4 h-4 mr-3" />
              Chat History
            </Button>
            <Button variant="ghost" className="w-full justify-start text-white hover:bg-gray-800/50">
              <Zap className="w-4 h-4 mr-3" />
              Quick Actions
            </Button>
            <Button variant="ghost" className="w-full justify-start text-white hover:bg-gray-800/50">
              <Settings className="w-4 h-4 mr-3" />
              Settings
            </Button>
            <Button variant="ghost" className="w-full justify-start text-white hover:bg-gray-800/50">
              <User className="w-4 h-4 mr-3" />
              Profile
            </Button>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex flex-col h-full lg:ml-64">
        {/* Header */}
        <div className="flex items-center justify-between p-4 lg:p-6 relative z-20">
          <div className="flex items-center gap-3">
            <Button 
              variant="ghost" 
              size="sm" 
              className="lg:hidden text-white hover:bg-white/10"
              onClick={() => setShowSidebar(true)}
            >
              <Menu className="w-5 h-5" />
            </Button>
            <h1 className="text-white text-lg lg:text-xl">AI Assistant</h1>
          </div>
          
          {showChat && (
            <Button 
              variant="ghost" 
              size="sm" 
              className="text-white hover:bg-white/10"
              onClick={() => setShowChat(false)}
            >
              <X className="w-5 h-5" />
            </Button>
          )}
        </div>

        {/* Content Area */}
        <div className="flex-1 relative z-10 px-4 lg:px-6">
          {!showChat ? (
            /* Welcome Screen */
            <div className="flex flex-col items-center justify-center h-full text-center space-y-6 lg:space-y-8">
              {/* Globe */}
              <div className="relative">
                <div className="w-32 h-32 lg:w-48 lg:h-48 relative">
                  <img 
                    src={globeImage} 
                    alt="AI Globe"
                    className="w-full h-full object-contain drop-shadow-2xl"
                  />
                  {(isListening || isSpeaking) && (
                    <div className="absolute inset-0 rounded-full border-4 border-cyan-400 animate-ping"></div>
                  )}
                  <div className="absolute inset-0 bg-gradient-to-r from-cyan-400/20 to-blue-400/20 rounded-full blur-xl"></div>
                </div>
              </div>

              {/* Welcome Text */}
              <div className="space-y-2 lg:space-y-4">
                <h2 className="text-2xl lg:text-4xl text-white">Hello there!</h2>
                <p className="text-lg lg:text-xl text-gray-200">I'm your AI assistant</p>
                <p className="text-base lg:text-lg text-gray-300 max-w-md">
                  Ready to help you with questions, tasks, and conversations
                </p>
              </div>

              {/* Quick Action Buttons */}
              <div className="flex flex-wrap gap-3 lg:gap-4 justify-center max-w-lg">
                <Button
                  onClick={() => setShowChat(true)}
                  className="bg-gray-700 hover:bg-gray-600 text-white border-0 px-6 py-3 rounded-full shadow-lg"
                >
                  <MessageSquare className="w-4 h-4 mr-2" />
                  Start Chat
                </Button>
                <Button
                  onClick={toggleConversationMode}
                  className={`${
                    conversationMode 
                      ? 'bg-red-600 hover:bg-red-500' 
                      : 'bg-green-600 hover:bg-green-500'
                  } text-white border-0 px-6 py-3 rounded-full shadow-lg`}
                >
                  {conversationMode ? (
                    <>
                      <MicOff className="w-4 h-4 mr-2" />
                      Stop Conversation
                    </>
                  ) : (
                    <>
                      <Mic className="w-4 h-4 mr-2" />
                      Start Conversation
                    </>
                  )}
                </Button>
                
                <Button
                  onClick={() => setAudioMode(!audioMode)}
                  disabled={!conversationMode}
                  className={`${
                    audioMode 
                      ? 'bg-blue-600 hover:bg-blue-500' 
                      : 'bg-gray-700 hover:bg-gray-600'
                  } text-white border-0 px-6 py-3 rounded-full shadow-lg disabled:opacity-50`}
                  title={conversationMode ? (audioMode ? 'Disable voice output' : 'Enable voice output') : 'Start conversation first'}
                >
                  <Volume2 className="w-4 h-4 mr-2" />
                  {audioMode ? 'Audio On' : 'Audio Off'}
                </Button>
              </div>
            </div>
          ) : (
            /* Chat Interface */
            <div className="h-full flex flex-col">
              {/* Chat Messages */}
              <div ref={messagesContainerRef} className="flex-1 overflow-y-auto mb-4 space-y-4 pb-4">
                {messages.length === 0 && !currentAIMessage && (
                  <div className="text-center py-8">
                    <p className="text-gray-300">Start a conversation...</p>
                    {!isConnected && (
                      <p className="text-red-400 text-sm mt-2">Connecting to server...</p>
                    )}
                  </div>
                )}
                
                {messages.map((message) => (
                  <div
                    key={message.id}
                    className={`flex ${message.sender === 'user' ? 'justify-end' : 'justify-start'}`}
                  >
                    <Card className={`max-w-[85%] lg:max-w-[70%] p-4 backdrop-blur-lg border-0 shadow-xl ${
                      message.sender === 'user' 
                        ? 'bg-gray-700/80 text-white' 
                        : 'bg-white/10 text-white border border-white/20'
                    }`}>
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-sm lg:text-base">{message.text}</p>
                        {message.sender === 'ai' && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="shrink-0 h-8 w-8 p-0 text-gray-300 hover:bg-white/10"
                            onClick={() => handleSpeak(message)}
                          >
                            <Volume2 className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                      <p className="text-xs opacity-70 mt-2">
                        {message.timestamp.toLocaleTimeString()}
                      </p>
                    </Card>
                  </div>
                ))}
                
                {/* Streaming AI message */}
                {currentAIMessage && (
                  <div className="flex justify-start">
                    <Card className="max-w-[85%] lg:max-w-[70%] p-4 backdrop-blur-lg border-0 shadow-xl bg-white/10 text-white border border-white/20">
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-sm lg:text-base">{currentAIMessage}</p>
                        <div className="shrink-0 h-8 w-8 flex items-center justify-center">
                          <div className="w-2 h-2 bg-cyan-400 rounded-full animate-pulse"></div>
                        </div>
                      </div>
                    </Card>
                  </div>
                )}
                
                <div ref={messagesEndRef} />
              </div>
            </div>
          )}
        </div>

        {/* Chat Input - Always at bottom */}
        <div className="p-4 lg:p-6 relative z-20">
          <Card className="backdrop-blur-lg bg-white/10 border border-white/20 p-4 shadow-xl">
            <div className="flex gap-3">
              <div className="flex-1 relative">
                <Input
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  onKeyPress={handleKeyPress}
                  placeholder="Type your message..."
                  className="bg-white/10 border-white/20 text-white placeholder:text-white/60 pr-12 rounded-full focus:ring-2 focus:ring-gray-400 focus:border-transparent"
                />
                <Button
                  variant="ghost"
                  size="sm"
                  className={`absolute right-2 top-1/2 -translate-y-1/2 h-8 w-8 p-0 ${
                    isListening ? 'text-red-400' : 'text-gray-300'
                  } hover:bg-white/10`}
                  onClick={handleVoiceInput}
                >
                  {isListening ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                </Button>
              </div>
              <Button 
                onClick={() => handleSendMessage()}
                data-send-button
                disabled={!inputText.trim() || !isConnected || isAIResponding}
                className="bg-gray-700 hover:bg-gray-600 text-white border-0 rounded-full px-6 shadow-lg disabled:opacity-50"
              >
                <Send className="h-4 w-4" />
              </Button>
            </div>
            
            {interimTranscript && (
              <div className="mt-3 p-3 bg-blue-500/20 rounded-lg border border-blue-400/30">
                <p className="text-sm text-blue-200 italic">
                  Listening: {interimTranscript}
                </p>
              </div>
            )}
            
            {isListening && !interimTranscript && (
              <div className="mt-3 text-center">
                <p className="text-sm text-gray-300 animate-pulse flex items-center justify-center gap-2">
                  <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce"></div>
                  Listening... Speak now
                  <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0.1s' }}></div>
                </p>
              </div>
            )}
            
            {isSpeaking && (
              <div className="mt-3 text-center">
                <p className="text-sm text-gray-300 animate-pulse flex items-center justify-center gap-2">
                  <Volume2 className="w-4 h-4" />
                  Speaking...
                </p>
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
