import { createCerebras } from '@ai-sdk/cerebras';
import { streamText } from 'ai';

// Initialize Cerebras provider
const cerebras = createCerebras({
  apiKey: process.env.CEREBRAS_API_KEY,
});

// Allow streaming responses up to 30 seconds
export const config = {
  runtime: 'edge',
  maxDuration: 30,
};

export default async function handler(req) {
  // Handle CORS
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const { messages, pdfContext, isInitial } = await req.json();

    // Build system prompt with PDF context
    let systemPrompt = `You are an enthusiastic, encouraging AI tutor helping a student learn from their study material.

Guidelines:
- Keep responses conversational and natural (2-4 sentences)
- Explain concepts clearly and check understanding
- Be warm and encouraging
- Keep it SHORT - responses will be spoken aloud
- Reference the material when relevant
- Ask engaging questions to check understanding`;

    if (pdfContext) {
      systemPrompt += `\n\n=== STUDY MATERIAL ===\n${pdfContext}\n\n=== END MATERIAL ===\n\nUse this material to guide your tutoring.`;
    }

    if (isInitial) {
      systemPrompt += `\n\nThis is the start of the conversation. Introduce a key concept from the material and ask the student what they know about it.`;
    }

    // Prepend system message to conversation
    const fullMessages = [
      { role: 'system', content: systemPrompt },
      ...messages,
    ];

    // Stream the response using Vercel AI SDK
    const result = streamText({
      model: cerebras('llama3.1-8b'),
      messages: fullMessages,
      temperature: 0.7,
      maxTokens: 800,
    });

    return result.toDataStreamResponse({
      headers: {
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (error) {
    console.error('Chat API error:', error);
    return new Response(
      JSON.stringify({ error: error.message || 'Internal server error' }),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      }
    );
  }
}