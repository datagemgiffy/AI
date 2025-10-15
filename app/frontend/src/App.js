import { useState, useEffect, useRef } from "react";
import "@/App.css";
import axios from "axios";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Upload, Send, Plus, Trash2, MessageSquare, FileText, Code2, X } from "lucide-react";
import ReactMarkdown from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;
const API = `${BACKEND_URL}/api`;

function App() {
  const [sessions, setSessions] = useState([]);
  const [currentSession, setCurrentSession] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [uploadedFiles, setUploadedFiles] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [htmlPreview, setHtmlPreview] = useState("");
  const [showPreview, setShowPreview] = useState(false);
  const messagesEndRef = useRef(null);
  const fileInputRef = useRef(null);

  useEffect(() => {
    loadSessions();
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  useEffect(() => {
    // Check if the last message contains HTML code
    if (messages.length > 0) {
      const lastMessage = messages[messages.length - 1];
      if (lastMessage.role === 'assistant') {
        const htmlMatch = lastMessage.content.match(/```html\n([\s\S]*?)```/);
        if (htmlMatch) {
          setHtmlPreview(htmlMatch[1]);
          setShowPreview(true);
        }
      }
    }
  }, [messages]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  const loadSessions = async () => {
    try {
      const response = await axios.get(`${API}/sessions`);
      setSessions(response.data);
    } catch (error) {
      console.error("Error loading sessions:", error);
    }
  };

  const createNewSession = async () => {
    try {
      const response = await axios.post(`${API}/sessions`);
      const newSession = response.data;
      setSessions(prev => [newSession, ...prev]);
      setCurrentSession(newSession.id);
      setMessages([]);
      setUploadedFiles([]);
      setShowPreview(false);
      return newSession.id;
    } catch (error) {
      console.error("Error creating session:", error);
      return null;
    }
  };

  const loadSession = async (sessionId) => {
    try {
      const response = await axios.get(`${API}/sessions/${sessionId}/messages`);
      setMessages(response.data);
      setCurrentSession(sessionId);
      setUploadedFiles([]);
      setShowPreview(false);
    } catch (error) {
      console.error("Error loading messages:", error);
    }
  };

  const deleteSession = async (sessionId, e) => {
    e.stopPropagation();
    try {
      await axios.delete(`${API}/sessions/${sessionId}`);
      setSessions(sessions.filter(s => s.id !== sessionId));
      if (currentSession === sessionId) {
        setCurrentSession(null);
        setMessages([]);
        setUploadedFiles([]);
        setShowPreview(false);
      }
    } catch (error) {
      console.error("Error deleting session:", error);
    }
  };

  const handleFileUpload = async (e) => {
    const files = Array.from(e.target.files);
    
    for (const file of files) {
      const formData = new FormData();
      formData.append("file", file);
      
      try {
        const response = await axios.post(`${API}/upload`, formData, {
          headers: { "Content-Type": "multipart/form-data" }
        });
        setUploadedFiles(prev => [...prev, response.data]);
      } catch (error) {
        console.error("Error uploading file:", error);
      }
    }
  };

  const removeFile = (fileId) => {
    setUploadedFiles(uploadedFiles.filter(f => f.id !== fileId));
  };

  const sendMessage = async () => {
    if (!input.trim() && uploadedFiles.length === 0) return;
    
    let sessionId = currentSession;
    
    if (!sessionId) {
      try {
        const response = await axios.post(`${API}/sessions`);
        const newSession = response.data;
        setSessions(prev => [newSession, ...prev]);
        setCurrentSession(newSession.id);
        sessionId = newSession.id;
      } catch (error) {
        console.error("Error creating session:", error);
        return;
      }
    }

    const fileIds = uploadedFiles.map(f => f.id);
    const userMessageText = input;
    
    // Add user message immediately
    const userMessage = {
      id: Date.now().toString(),
      session_id: sessionId,
      role: "user",
      content: userMessageText,
      timestamp: new Date(),
      files: fileIds.length > 0 ? fileIds : null
    };
    setMessages(prev => [...prev, userMessage]);
    setInput("");
    setUploadedFiles([]);
    setIsLoading(true);

    try {
      console.log("Sending message to:", `${API}/chat/stream`);
      const response = await fetch(`${API}/chat/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: userMessageText,
          session_id: sessionId,
          files: fileIds.length > 0 ? fileIds : null
        })
      });

      console.log("Response status:", response.status);

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let assistantMessage = {
        id: (Date.now() + 1).toString(),
        session_id: sessionId,
        role: "assistant",
        content: "",
        timestamp: new Date()
      };

      setMessages(prev => [...prev, assistantMessage]);
      console.log("Starting to read stream...");

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          console.log("Stream complete");
          break;
        }

        const chunk = decoder.decode(value, { stream: true });
        console.log("Received chunk:", chunk);
        const lines = chunk.split("\n");

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.slice(6));
              console.log("Parsed data:", data);
              if (data.content) {
                assistantMessage.content = data.content;
                setMessages(prev => {
                  const updated = [...prev];
                  updated[updated.length - 1] = { ...assistantMessage };
                  return updated;
                });
              }
              if (data.error) {
                console.error("Stream error:", data.error);
              }
            } catch (e) {
              console.error("Error parsing SSE data:", e, line);
            }
          }
        }
      }
    } catch (error) {
      console.error("Error sending message:", error);
      // Add error message to chat
      setMessages(prev => [...prev, {
        id: Date.now().toString(),
        session_id: sessionId,
        role: "assistant",
        content: "Sorry, I encountered an error. Please try again.",
        timestamp: new Date()
      }]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyPress = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <div className="app-container">
      {/* Sidebar */}
      <div className="sidebar">
        <div className="sidebar-header">
          <h1 className="sidebar-title">
            <Code2 className="w-6 h-6" />
            AI Assistant
          </h1>
          <Button
            onClick={createNewSession}
            className="new-chat-btn"
            size="sm"
            data-testid="new-chat-button"
          >
            <Plus className="w-4 h-4" />
            New Chat
          </Button>
        </div>
        
        <ScrollArea className="sidebar-sessions">
          {sessions.map((session) => (
            <div
              key={session.id}
              className={`session-item ${currentSession === session.id ? 'active' : ''}`}
              onClick={() => loadSession(session.id)}
              data-testid={`session-${session.id}`}
            >
              <MessageSquare className="w-4 h-4" />
              <span className="session-title">{session.title}</span>
              <Button
                variant="ghost"
                size="icon"
                className="delete-btn"
                onClick={(e) => deleteSession(session.id, e)}
                data-testid={`delete-session-${session.id}`}
              >
                <Trash2 className="w-4 h-4" />
              </Button>
            </div>
          ))}
        </ScrollArea>
      </div>

      {/* Main Chat Area */}
      <div className="main-content">
        <div className="chat-container">
          <ScrollArea className="messages-area">
            {messages.length === 0 ? (
              <div className="empty-state">
                <Code2 className="w-16 h-16 mb-4 empty-icon" />
                <h2 className="empty-title">Start a Conversation</h2>
                <p className="empty-description">
                  Upload files (documents, images, code) or ask me anything.
                  I can analyze files, generate code, and help with your questions.
                </p>
              </div>
            ) : (
              <div className="messages-list">
                {messages.map((message) => (
                  <div
                    key={message.id}
                    className={`message ${message.role}`}
                    data-testid={`message-${message.role}`}
                  >
                    <div className="message-content">
                      {message.role === 'assistant' ? (
                        <ReactMarkdown
                          components={{
                            code({ node, inline, className, children, ...props }) {
                              const match = /language-(\w+)/.exec(className || '');
                              return !inline && match ? (
                                <SyntaxHighlighter
                                  style={vscDarkPlus}
                                  language={match[1]}
                                  PreTag="div"
                                  {...props}
                                >
                                  {String(children).replace(/\n$/, '')}
                                </SyntaxHighlighter>
                              ) : (
                                <code className={className} {...props}>
                                  {children}
                                </code>
                              );
                            }
                          }}
                        >
                          {message.content}
                        </ReactMarkdown>
                      ) : (
                        <p>{message.content}</p>
                      )}
                      {message.files && message.files.length > 0 && (
                        <div className="message-files">
                          <FileText className="w-4 h-4" />
                          {message.files.length} file(s) attached
                        </div>
                      )}
                    </div>
                  </div>
                ))}
                <div ref={messagesEndRef} />
              </div>
            )}
          </ScrollArea>

          {/* Input Area */}
          <div className="input-container">
            {uploadedFiles.length > 0 && (
              <div className="uploaded-files">
                {uploadedFiles.map((file) => (
                  <div key={file.id} className="file-chip" data-testid={`uploaded-file-${file.id}`}>
                    <FileText className="w-4 h-4" />
                    <span>{file.filename}</span>
                    <button onClick={() => removeFile(file.id)} className="remove-file-btn">
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            
            <div className="input-wrapper">
              <Textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyPress={handleKeyPress}
                placeholder="Type your message..."
                className="message-input"
                rows={2}
                disabled={isLoading}
                data-testid="message-input"
              />
              
              <div className="input-actions">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  onChange={handleFileUpload}
                  className="hidden"
                  data-testid="file-input"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isLoading}
                  data-testid="upload-button"
                >
                  <Upload className="w-5 h-5" />
                </Button>
                <Button
                  onClick={sendMessage}
                  disabled={isLoading || (!input.trim() && uploadedFiles.length === 0)}
                  className="send-btn"
                  data-testid="send-button"
                >
                  <Send className="w-5 h-5" />
                </Button>
              </div>
            </div>
          </div>
        </div>

        {/* HTML Preview Panel */}
        {showPreview && (
          <div className="preview-panel">
            <div className="preview-header">
              <h3 className="preview-title">HTML Preview</h3>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setShowPreview(false)}
                data-testid="close-preview-button"
              >
                <X className="w-4 h-4" />
              </Button>
            </div>
            <Separator />
            <div className="preview-content">
              <iframe
                srcDoc={htmlPreview}
                title="HTML Preview"
                className="preview-iframe"
                sandbox="allow-scripts"
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
