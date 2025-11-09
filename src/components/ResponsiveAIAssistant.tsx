// src/components/ResponsiveAIAssistant.tsx (FINAL COMPLETE REPLACEMENT)

import React, { useState, useRef, useEffect } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Card } from './ui/card';
import { Mic, MicOff, Send, Settings, Menu, X, MessageSquare, Zap, Volume2, User } from 'lucide-react';
import globeImage from '../assets/parley.png';
import { io, Socket } from 'socket.io-client';

// === PROP DEFINITIONS ===
interface SessionDataType { 
  sessionId: string; 
  filename: string; 
  initialMessage: string;
}

interface ResponsiveAIAssistantProps {
  sessionData: SessionDataType | null;
  setSessionData: React.Dispatch<React.SetStateAction<SessionDataType | null>>;
}

interface Message {
  id: string;
  text: string;
  sender: 'user' | 'ai';
  timestamp: Date;
}

// Ensure this matches the API base URL in usePdfUploader.js for the reset call
const API_BASE_URL = 'http://localhost:8501'; 


// === ACTIVE PDF STATUS ELEMENT (Sidebar) ===
const ActivePdfDisplay: React.FC<ResponsiveAIAssistantProps & {setShowModal: React.Dispatch<React.SetStateAction<boolean>>; setContent: React.Dispatch<React.SetStateAction<string>>}> = ({ sessionData, setSessionData, setShowModal, setContent }) => {
    if (!sessionData) {
        return null; 
    }

    const handleResetClick = () => {
        if (!window.confirm("Are you sure you want to remove the study material and reset the conversation?")) {
            return;
        }
        
        // 1. Clear session on the server
        fetch(`${API_BASE_URL}/api/reset`, { 
            method: 'POST', 
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: sessionData.sessionId })
        }).catch(err => console.error("Error resetting server session:", err));
        
        // 2. Clear state on the frontend
        setSessionData(null);
    };

    const handleViewClick = async () => {
        setContent('Loading PDF content...');
        setShowModal(true);
        
        try {
            const response = await fetch(`${API_BASE_URL}/api/pdf-content?sessionId=${sessionData.sessionId}`);
            
            // FIX: Check for successful JSON parsing response headers
            if (!response.ok) {
                 const errorText = await response.text();
                 // If the response is HTML (starts with <!), the server crashed.
                 if (errorText.startsWith("<!")) {
                    setContent(`Server Error: The backend crashed while fetching the PDF content. Please check the Flask console.`);
                 } else {
                    // Try to parse JSON error message if the server followed the protocol
                    const errorJson = JSON.parse(errorText);
                    setContent(`Error: ${errorJson.error || 'Unknown server error.'}`);
                 }
                 return;
            }

            const result = await response.json();

            if (result.success) {
                setContent(result.pdfText);
            } else {
                setContent(`Error: Could not retrieve PDF text. ${result.error || 'Server failed.'}`);
            }
        } catch (error) {
            setContent(`Network Error: ${error.message}. Ensure the Flask server is running and accessible at ${API_BASE_URL}.`);
        }
    };

    return (
        <div className="p-4 border-t border-b border-gray-700/50 space-y-2">
            <h4 className="text-gray-300 text-sm font-semibold">📚 Active Study Material</h4>
            <div className="flex flex-col gap-2">
                <div 
                    className="bg-gray-800/80 text-white p-2 rounded-md truncate" 
                    title={sessionData.filename}
                >
                    <span className="text-cyan-400 mr-2">📄</span>
                    {sessionData.filename.length > 25 
                        ? sessionData.filename.substring(0, 22) + '...' 
                        : sessionData.filename}
                </div>
                
                <Button 
                    onClick={handleViewClick}
                    variant="default"
                    size="sm"
                    className="w-full text-xs bg-cyan-600 hover:bg-cyan-500"
                >
                    View Full PDF Content
                </Button>
                
                <Button 
                    onClick={handleResetClick}
                    variant="destructive"
                    size="sm"
                    className="w-full text-xs"
                >
                    <X className="w-3 h-3 mr-1" /> Remove & Reset Session
                </Button>
            </div>
        </div>
    );
};
// ==========================================================


// === Main Component: ResponsiveAIAssistant ===
export function ResponsiveAIAssistant({ sessionData, setSessionData }: ResponsiveAIAssistantProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [showSidebar, setShowSidebar] = useState(false);
  const [recognition, setRecognition] = useState<SpeechRecognition | null>(null);
  const [speechSynthesis, setSpeechSynthesis] = useState<SpeechSynthesis | null>(null);
  const [socket, setSocket] = useState<Socket | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const [sessionId, setSessionId] = useState<string>('');
  const sessionIdRef = useRef<string>('');
  const [isConnected, setIsConnected] = useState(false);
  const [currentAIMessage, setCurrentAIMessage] = useState<string>('');
  const [isAIResponding, setIsAIResponding] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const speechQueueRef = useRef<string[]>([]);
  const isSpeakingRef = useRef(false);

  const [conversationMode, setConversationMode] = useState(true);
  const [isConversationLocked, setIsConversationLocked] = useState(false); 
  const [audioMode, setAudioMode] = useState(true);
  const [interimTranscript, setInterimTranscript] = useState('');
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const isRecognitionRunningRef = useRef(false);
  const lastTranscriptRef = useRef<string>('');

  const [showPdfModal, setShowPdfModal] = useState(false); 
  const [pdfContent, setPdfContent] = useState('Loading PDF content...');
  
  // *** PROP/STATE INTEGRATION: Load session data and auto-show chat ***
  useEffect(() => {
    if (sessionData && !showChat) {
        setShowChat(true);
        
        const hasInitialMessage = messages.some(msg => msg.text === sessionData.initialMessage);
        
        if (sessionData.initialMessage && !hasInitialMessage) {
             const initialMsg: Message = {
                id: Date.now().toString(),
                text: sessionData.initialMessage,
                sender: 'ai',
                timestamp: new Date()
            };
            setMessages(prev => [...prev, initialMsg]);
        }
    } else if (!sessionData && messages.length > 0) {
        setMessages([]);
        setShowChat(false);
        setIsConversationLocked(true); 
    }
  }, [sessionData, showChat, messages.length]);
  // *******************************************************************
  
  useEffect(() => {
    // Initialize speech recognition
    if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      const recognitionInstance = new SpeechRecognition();
      recognitionInstance.continuous = true;
      recognitionInstance.interimResults = true;
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
        
        const currentText = finalText || interimText;
        if (currentText) {
          lastTranscriptRef.current = currentText;
          setInterimTranscript(currentText);
        }
      };
      
      recognitionInstance.onspeechend = () => {
        recognitionInstance.stop(); 
      };

      recognitionInstance.onspeechstart = () => {
        lastTranscriptRef.current = '';
      };
      
      recognitionInstance.onerror = (event) => {
        if (event.error === 'no-speech' || event.error === 'aborted') {
          if (conversationMode && !isConversationLocked) {
            setTimeout(() => recognition?.start(), 1000);
          }
        } else {
          setConversationMode(false);
          setIsListening(false);
          setIsConversationLocked(true);
        }
      };

      recognitionInstance.onend = () => {
        isRecognitionRunningRef.current = false;
        
        const textToSend = lastTranscriptRef.current.trim();
        if (textToSend && conversationMode) {
            handleSendMessage(textToSend);
            setInterimTranscript('');
            lastTranscriptRef.current = '';
        }
        
        if (conversationMode && !isAIResponding && !isConversationLocked) {
          const delay = audioMode ? 1500 : 500;
          
          setTimeout(() => {
            if (!isRecognitionRunningRef.current) {
              try {
                recognition.start();
                isRecognitionRunningRef.current = true;
              } catch (e) {
                console.error('[Speech] Failed to restart:', e);
              }
            }
          }, delay);
        } else {
          setIsListening(false);
        }
      };

      setRecognition(recognitionInstance);
    }

    // Initialize speech synthesis
    if ('speechSynthesis' in window) {
      setSpeechSynthesis(window.speechSynthesis);
    }

    // Initialize WebSocket connection
    const newSocket = io('http://localhost:8501', {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: 5
    });
    
    newSocket.on('connect', () => {
      setIsConnected(true);
    });

    newSocket.on('connected', (data) => {
      setSessionId(data.sessionId);
      sessionIdRef.current = data.sessionId;
      
      newSocket.emit('join_session', { sessionId: data.sessionId });
    });

    newSocket.on('session_joined', (data) => {
      setIsConnected(true);
      sessionIdRef.current = data.sessionId;
      
      if (!sessionData && data.history && data.history.length > 0) {
        
        const lastAIMessage = data.history.slice().reverse().find((msg: any) => msg.role === 'tutor');
        if (lastAIMessage && audioMode) {
             speakChunk(lastAIMessage.content); 
        }

        const loadedMessages: Message[] = data.history.map((msg: any, idx: number) => ({
          id: `history-${idx}`,
          text: msg.content,
          sender: msg.role === 'user' ? 'user' : 'ai',
          timestamp: new Date()
        }));
        setMessages(loadedMessages);
        setShowChat(true);
      }
    });

    newSocket.on('ai_start', () => {
      setIsAIResponding(true);
      setCurrentAIMessage('');
    });

    newSocket.on('ai_chunk', (data) => {
      setCurrentAIMessage(prev => prev + data.content);
      if (audioMode) { 
        speakChunk(data.content);
      }
    });

    newSocket.on('ai_complete', (data) => {
      setIsAIResponding(false);
      
      const aiMessage: Message = {
        id: Date.now().toString(),
        text: data.fullResponse,
        sender: 'ai',
        timestamp: new Date()
      };
      setMessages(prev => [...prev, aiMessage]);
      setCurrentAIMessage('');
      
      if (conversationMode && recognition && !isConversationLocked) {
        const delay = audioMode ? 1500 : 500;
        
        setTimeout(() => {
          if (!isRecognitionRunningRef.current) {
            try {
              recognition.start();
              isRecognitionRunningRef.current = true;
            } catch (e) {
              console.error('[Speech] Failed to restart:', e);
            }
          }
        }, delay);
      }
    });

    newSocket.on('error', (data) => {
      alert(`Error: ${data.message}`);
      setIsAIResponding(false);
    });

    newSocket.on('disconnect', () => {
      setIsConnected(false);
    });

    setSocket(newSocket);
    socketRef.current = newSocket;

    return () => {
      newSocket.close();
    };
  }, []);

  useEffect(() => {
    const container = messagesContainerRef.current;
    if (container) {
      const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 100;
      
      if (isNearBottom) {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      }
    }
  }, [messages, currentAIMessage]);

  const speakChunk = (text: string) => {
    if (!speechSynthesis || !text.trim()) return;
    
    speechQueueRef.current.push(text);
    
    if (!isSpeakingRef.current) {
      processNextSpeech();
    }
  };

  const processNextSpeech = () => {
    if (speechQueueRef.current.length === 0) {
      isSpeakingRef.current = false;
      setIsSpeaking(false);
      return;
    }

    isSpeakingRef.current = true;
    setIsSpeaking(true);

    const text = speechQueueRef.current.shift()!;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 0.9;
    utterance.pitch = 1;
    
    utterance.onend = () => {
      processNextSpeech();
    };
    
    utterance.onerror = () => {
      processNextSpeech();
    };

    speechSynthesis!.speak(utterance);
  };
  
  const toggleConversationMode = () => {
    if (!recognition) {
      alert('Speech recognition not supported');
      return;
    }
    
    if (conversationMode) {
      recognition.stop(); 
      isRecognitionRunningRef.current = false;
      setConversationMode(false);
      setAudioMode(false);
      setIsListening(false);
      setIsConversationLocked(true);

    } else if (!isConversationLocked) {
      if (!isRecognitionRunningRef.current) {
        try {
          recognition.start();
          isRecognitionRunningRef.current = true;
          setConversationMode(true);
          setAudioMode(true);
          setIsListening(true);
        } catch (e) {
          console.error('[Speech] Failed to start conversation mode:', e);
        }
      }
    }
  };

  const handleSendMessage = (messageText?: string) => {
    const textToSend = messageText || inputText;
    
    const activeSocket = socketRef.current || socket;
    const activeSessionId = sessionData?.sessionId || sessionIdRef.current || sessionId;
    
    if (!textToSend.trim() || !activeSocket || !activeSessionId) {
      if (!activeSocket || !activeSessionId) {
        alert('Not connected to server. Please wait...');
      }
      return;
    }

    const userMessage: Message = {
      id: Date.now().toString(),
      text: textToSend,
      sender: 'user',
      timestamp: new Date()
    };

    setMessages(prev => [...prev, userMessage]);
    setShowChat(true);

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
    } else {
      if (!isRecognitionRunningRef.current) {
        try {
          recognition.start();
          isRecognitionRunningRef.current = true;
          setIsListening(true);
        } catch (e) {
          console.error('[Speech] Failed to start:', e);
        }
      }
    }
  };
  
  const handleSpeak = (text: string) => {
    if (!speechSynthesis) {
      alert('Speech synthesis is not supported in your browser.');
      return;
    }

    if (isSpeaking) {
      speechSynthesis.cancel();
      speechQueueRef.current = [];
      isSpeakingRef.current = false;
      setIsSpeaking(false);
      return;
    }

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 0.9;
    utterance.pitch = 1;
    
    utterance.onstart = () => setIsSpeaking(true);
    utterance.onend = () => setIsSpeaking(false);
    utterance.onerror = () => setIsSpeaking(false);

    speechSynthesis.speak(utterance);
  };
  
  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };


  return (
      <div className="h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-neutral-900 relative overflow-hidden">
        
        {/* === PDF Modal (New Element) === */}
        {showPdfModal && (
            <div 
                className="fixed inset-0 bg-black/90 z-[60] flex items-center justify-center p-4" 
                onClick={() => setShowPdfModal(false)}
            >
                <Card 
                    className="w-[90%] lg:w-[70%] h-[90%] bg-gray-950 border border-gray-700 p-6 flex flex-col shadow-2xl"
                    onClick={(e) => e.stopPropagation()} 
                >
                    <div className="flex justify-between items-center mb-4 border-b border-gray-700 pb-2">
                        <h3 className="text-xl text-white">Full Content: {sessionData?.filename}</h3>
                        <Button 
                            variant="ghost" 
                            onClick={() => setShowPdfModal(false)}
                            className="text-white hover:bg-red-700/50"
                        >
                            <X className="w-6 h-6" />
                        </Button>
                    </div>
                    <div className="flex-1 overflow-y-auto bg-gray-900 p-4 rounded-md text-gray-300 whitespace-pre-wrap font-mono text-sm">
                        {pdfContent}
                    </div>
                </Card>
            </div>
        )}
        {/* =============================== */}

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
              
              {/* === MOBILE PDF DISPLAY === */}
              <ActivePdfDisplay 
                sessionData={sessionData} 
                setSessionData={setSessionData} 
                setShowModal={setShowPdfModal}
                setContent={setPdfContent}
              />
              {/* ========================== */}

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
          
          {/* === DESKTOP PDF DISPLAY === */}
          <ActivePdfDisplay 
            sessionData={sessionData} 
            setSessionData={setSessionData} 
            setShowModal={setShowPdfModal}
            setContent={setPdfContent}
          />
          {/* ============================= */}

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
          {sessionData || showChat ? ( 
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
                            onClick={() => handleSpeak(message.text)}
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
          ) : (
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
                  disabled={isConversationLocked} // Lock after manual stop
                  className={`${
                    conversationMode 
                      ? 'bg-red-600 hover:bg-red-500' 
                      : 'bg-green-600 hover:bg-green-500'
                  } text-white border-0 px-6 py-3 rounded-full shadow-lg disabled:opacity-50`}
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