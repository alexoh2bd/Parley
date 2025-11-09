// src/App.tsx (Check that this is EXACTLY what you have)

import React from 'react';
import { ResponsiveAIAssistant } from "./components/ResponsiveAIAssistant";

// Define a simple structure for session data types
interface SessionData {
  sessionId: string;
  filename: string;
  initialMessage: string;
}

// Define the expected props structure for App
interface AppProps {
  // sessionData can be the object or null
  sessionData: SessionData | null;
  
  // The setter function type (simplified for broad compatibility)
  // This type handles both passing the new value or a function to update the old value
  setSessionData: React.Dispatch<React.SetStateAction<SessionData | null>>;
}

// Accept the props and pass them down to the main UI component
export default function App(props: AppProps) {
  // Use a fragment or simply return the component with props spread
  return <ResponsiveAIAssistant {...props} />;
}