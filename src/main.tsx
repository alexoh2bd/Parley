// src/main.tsx (COMPLETE REPLACEMENT)

import React, { useState } from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
import './index.css';
// Ensure the extension matches your file name
import { usePdfUploader } from './usePdfUploader.js'; 

// Define the type for session data globally
type SessionDataType = { 
    sessionId: string; 
    filename: string; 
    initialMessage: string;
} | null;


// --- Loading Overlay Component (Full Screen) ---
const LoadingOverlay: React.FC<{ status: string; filename: string }> = ({ status, filename }) => (
    <div style={loadingPageStyle}>
        <div style={loadingBoxStyle}>
            <h2>📄 Processing Study Material...</h2>
            <p>File: **{filename}**</p>
            <div style={{ height: '20px', backgroundColor: '#333', borderRadius: '4px', overflow: 'hidden', marginTop: '10px' }}>
                <div style={loadingBarStyle} />
            </div>
            <p style={{ marginTop: '10px' }}>Status: *{status}*</p>
            <p style={{ marginTop: '20px', color: '#ccc' }}>Conversation is initializing with Cerebras. Please wait.</p>
        </div>
    </div>
);

// --- Status/Error Banner Component (Bottom Right) ---
const StatusBanner: React.FC<{ uploadError: Error | null; isUploading: boolean; uploadStatus: string }> = ({ uploadError, isUploading, uploadStatus }) => {
    if (uploadError) {
        return (
            <div style={{...statusOverlayStyle, backgroundColor: '#dc3545', color: 'white'}}>
                ❌ **Upload Error:** {uploadError.message}
            </div>
        );
    }
    if (isUploading) {
        return (
            <div style={{...statusOverlayStyle, backgroundColor: '#ffc107', color: '#333'}}>
                ⏳ **Status:** {uploadStatus}
            </div>
        );
    }
    return null;
};


// === App Wrapper Component (Handles State and Hook) ===
const AppWrapper = () => {
    const [sessionData, setSessionData] = useState<SessionDataType>(null);
    // usePdfUploader's onUploadSuccess callback is setSessionData
    const { isUploading, uploadStatus, uploadError } = usePdfUploader(setSessionData);

    const showLoader = isUploading && !uploadError;
    const currentFileName = sessionData?.filename || (isUploading && uploadStatus.includes('Processing') ? uploadStatus.split(' ')[1] : 'Document');

    return (
        <>
            {showLoader && (
                <LoadingOverlay 
                    status={uploadStatus} 
                    filename={currentFileName}
                />
            )}
            
            {/* Pass BOTH data and setter function to App.tsx */}
            <App 
                sessionData={sessionData} 
                setSessionData={setSessionData} 
            /> 
            
            <StatusBanner 
                uploadError={uploadError} 
                isUploading={isUploading} 
                uploadStatus={uploadStatus} 
            />
        </>
    );
};
// ========================================================


// --- STYLES (Simple styles for the banner/loader) ---
const loadingPageStyle: React.CSSProperties = {
    position: 'fixed', top: 0, left: 0, width: '100%', height: '100%',
    backgroundColor: 'rgba(0, 0, 0, 0.95)', zIndex: 2000, display: 'flex',
    alignItems: 'center', justifyContent: 'center',
};
const loadingBoxStyle: React.CSSProperties = {
    backgroundColor: '#1e1e1e', color: 'white', padding: '40px',
    borderRadius: '10px', textAlign: 'center', width: '400px',
    boxShadow: '0 8px 30px rgba(0,0,0,0.5)',
};
const loadingBarStyle: React.CSSProperties = {
    width: '100%', height: '100%', backgroundColor: '#007bff',
};
const statusOverlayStyle: React.CSSProperties = { 
    position: 'fixed', bottom: '20px', right: '20px', 
    padding: '15px', borderRadius: '8px', zIndex: 1000, 
    boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
    transition: 'opacity 0.3s ease'
};
// ---------------------------------------------------


ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppWrapper />
  </React.StrictMode>,
);