from fastapi import FastAPI, APIRouter, UploadFile, File, Form, HTTPException
from fastapi.responses import StreamingResponse
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import logging
from pathlib import Path
from pydantic import BaseModel, Field, ConfigDict
from typing import List, Optional
import uuid
from datetime import datetime, timezone
import json
import asyncio
from emergentintegrations.llm.chat import LlmChat, UserMessage, FileContentWithMimeType
import shutil
import base64

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

# MongoDB connection
mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]

# Create the main app without a prefix
app = FastAPI()

# Create a router with the /api prefix
api_router = APIRouter(prefix="/api")

# File upload directory
UPLOAD_DIR = ROOT_DIR / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)

# Models
class Message(BaseModel):
    model_config = ConfigDict(extra="ignore")
    
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    session_id: str
    role: str  # 'user' or 'assistant'
    content: str
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    files: Optional[List[str]] = None

class ChatRequest(BaseModel):
    message: str
    session_id: str
    files: Optional[List[str]] = None

class ChatSession(BaseModel):
    model_config = ConfigDict(extra="ignore")
    
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    title: str
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

# Helper function to prepare data for MongoDB
def prepare_for_mongo(data):
    if isinstance(data.get('timestamp'), datetime):
        data['timestamp'] = data['timestamp'].isoformat()
    if isinstance(data.get('created_at'), datetime):
        data['created_at'] = data['created_at'].isoformat()
    if isinstance(data.get('updated_at'), datetime):
        data['updated_at'] = data['updated_at'].isoformat()
    return data

def parse_from_mongo(item):
    if isinstance(item.get('timestamp'), str):
        item['timestamp'] = datetime.fromisoformat(item['timestamp'])
    if isinstance(item.get('created_at'), str):
        item['created_at'] = datetime.fromisoformat(item['created_at'])
    if isinstance(item.get('updated_at'), str):
        item['updated_at'] = datetime.fromisoformat(item['updated_at'])
    return item

@api_router.get("/")
async def root():
    return {"message": "AI Chatbot API"}

@api_router.post("/upload")
async def upload_file(file: UploadFile = File(...)):
    """Upload a file and return its path"""
    try:
        file_id = str(uuid.uuid4())
        file_extension = Path(file.filename).suffix
        file_path = UPLOAD_DIR / f"{file_id}{file_extension}"
        
        # Save file
        with open(file_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
        
        # Store file metadata in database
        file_doc = {
            "id": file_id,
            "filename": file.filename,
            "path": str(file_path),
            "content_type": file.content_type,
            "size": os.path.getsize(file_path),
            "uploaded_at": datetime.now(timezone.utc).isoformat()
        }
        await db.files.insert_one(file_doc)
        
        return {
            "id": file_id,
            "filename": file.filename,
            "content_type": file.content_type,
            "size": file_doc["size"]
        }
    except Exception as e:
        logging.error(f"Error uploading file: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@api_router.post("/chat/stream")
async def chat_stream(request: ChatRequest):
    """Stream chat responses"""
    try:
        # Get API key
        api_key = os.environ.get('EMERGENT_LLM_KEY')
        if not api_key:
            raise HTTPException(status_code=500, detail="API key not configured")
        
        # Initialize chat with Gemini (supports file attachments)
        chat = LlmChat(
            api_key=api_key,
            session_id=request.session_id,
            system_message="You are a helpful AI assistant. You can analyze documents, images, code, and more. When generating code, use markdown format with appropriate language tags. When generating HTML code, make sure it's complete and functional."
        ).with_model("gemini", "gemini-2.0-flash")
        
        # Prepare file attachments if any
        file_contents = []
        if request.files:
            for file_id in request.files:
                # Get file from database
                file_doc = await db.files.find_one({"id": file_id}, {"_id": 0})
                if file_doc:
                    file_path = file_doc["path"]
                    content_type = file_doc["content_type"]
                    
                    # Create file content with mime type
                    file_content = FileContentWithMimeType(
                        file_path=file_path,
                        mime_type=content_type
                    )
                    file_contents.append(file_content)
        
        # Create user message
        user_msg = UserMessage(
            text=request.message,
            file_contents=file_contents if file_contents else None
        )
        
        # Save user message to database
        user_message = Message(
            session_id=request.session_id,
            role="user",
            content=request.message,
            files=request.files
        )
        user_doc = prepare_for_mongo(user_message.model_dump())
        await db.messages.insert_one(user_doc)
        
        # Update session
        await db.sessions.update_one(
            {"id": request.session_id},
            {"$set": {"updated_at": datetime.now(timezone.utc).isoformat()}},
            upsert=True
        )
        
        # Stream response
        async def generate():
            try:
                # Get response from LLM
                response = await chat.send_message(user_msg)
                
                # Save assistant message
                assistant_message = Message(
                    session_id=request.session_id,
                    role="assistant",
                    content=response
                )
                assistant_doc = prepare_for_mongo(assistant_message.model_dump())
                await db.messages.insert_one(assistant_doc)
                
                # Stream the response
                yield f"data: {json.dumps({'content': response, 'done': True})}\n\n"
            except Exception as e:
                logging.error(f"Error in chat stream: {e}")
                yield f"data: {json.dumps({'error': str(e)})}\n\n"
        
        return StreamingResponse(generate(), media_type="text/event-stream")
    
    except Exception as e:
        logging.error(f"Error in chat endpoint: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@api_router.get("/sessions", response_model=List[ChatSession])
async def get_sessions():
    """Get all chat sessions"""
    sessions = await db.sessions.find({}, {"_id": 0}).sort("updated_at", -1).to_list(100)
    for session in sessions:
        parse_from_mongo(session)
        # Ensure all required fields exist
        if 'title' not in session:
            session['title'] = 'New Chat'
        if 'created_at' not in session:
            session['created_at'] = session.get('updated_at', datetime.now(timezone.utc))
    return sessions

@api_router.post("/sessions", response_model=ChatSession)
async def create_session():
    """Create a new chat session"""
    session = ChatSession(title="New Chat")
    session_doc = prepare_for_mongo(session.model_dump())
    await db.sessions.insert_one(session_doc)
    return session

@api_router.get("/sessions/{session_id}/messages", response_model=List[Message])
async def get_messages(session_id: str):
    """Get all messages for a session"""
    messages = await db.messages.find({"session_id": session_id}, {"_id": 0}).sort("timestamp", 1).to_list(1000)
    for msg in messages:
        parse_from_mongo(msg)
    return messages

@api_router.delete("/sessions/{session_id}")
async def delete_session(session_id: str):
    """Delete a chat session and its messages"""
    await db.sessions.delete_one({"id": session_id})
    await db.messages.delete_many({"session_id": session_id})
    return {"message": "Session deleted"}

# Include the router in the main app
app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get('CORS_ORIGINS', '*').split(','),
    allow_methods=["*"],
    allow_headers=["*"],
)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
