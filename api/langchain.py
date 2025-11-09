"""LangChain agent for chat with streaming using Cerebras."""
import os
from typing import AsyncGenerator, Optional
import logging
from langchain_cerebras import ChatCerebras
from langchain.memory import ConversationBufferMemory
from langchain.schema import HumanMessage, AIMessage


logger = logging.getLogger(__name__)

# In-memory session storage (use Redis in production)
_session_memories = {}


async def run_chat_stream(
    user_input: str,
    session_id: Optional[str] = None,
) -> AsyncGenerator[str, None]:
    """Run chat with streaming response using RAG.
    
    Args:
        user_input: User's message
        session_id: Session ID for conversation history
        namespace: Vector DB namespace to search
        
    Yields:
        Response chunks as they're generated

    """
    try:
        # Initialize Cerebras LLM with streaming
        llm = ChatCerebras(
            model="llama-3.3-70b",
            temperature=0.7,
            streaming=True,
            cerebras_api_key=os.getenv("CEREBRAS_API_KEY")
        )
        
        # Get or create conversation memory
        if session_id and session_id in _session_memories:
            memory = _session_memories[session_id]
        else:
            memory = ConversationBufferMemory(
                memory_key="chat_history",
                return_messages=True
            )
            if session_id:
                _session_memories[session_id] = memory
        
        # Build message list with conversation history
        messages = []
        
        # Add conversation history from memory
        if memory.chat_memory.messages:
            messages.extend(memory.chat_memory.messages)
        
        # Add current user message
        messages.append(HumanMessage(content=user_input))
        
        # Stream response
        response = ""
        async for chunk in llm.astream(messages):
            if chunk.content:
                response += chunk.content
                yield f"data: {chunk.content}\n\n"
        
        # Save conversation to memory
        memory.chat_memory.add_user_message(user_input)
        memory.chat_memory.add_ai_message(response)
        
        yield "data: [DONE]\n\n"
        
    except Exception as e:
        logger.error(f"Error in chat stream: {e}")
        yield f"data: Error: {str(e)}\n\n"
        yield "data: [DONE]\n\n"


def clear_session_memory(session_id: str) -> bool:
    """Clear conversation memory for a session."""
    if session_id in _session_memories:
        del _session_memories[session_id]
        return True
    return False


def get_session_history(session_id: str) -> list:
    """Get conversation history for a session."""
    if session_id in _session_memories:
        memory = _session_memories[session_id]
        return memory.chat_memory.messages
    return []