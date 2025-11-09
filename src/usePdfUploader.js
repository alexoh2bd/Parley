// src/usePdfUploader.js

import { useState, useEffect, useCallback } from 'react';
// Correct Vite import for the main library
import * as pdfjsLib from 'pdfjs-dist'; 
// Correct Vite import for the worker file URL
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'; 

// === API Configuration ===
// IMPORTANT: Ensure your Flask server is running on this host and port (default 8501).
const API_BASE_URL = 'http://localhost:8501'; 
// =========================

/**
 * Custom React Hook to handle global PDF drag-and-drop file uploads.
 */
export function usePdfUploader(onUploadSuccess) {
    const [isUploading, setIsUploading] = useState(false);
    const [uploadStatus, setUploadStatus] = useState('');
    const [uploadError, setUploadError] = useState(null);

    // Set the worker source using the imported URL object for Vite compatibility.
    if (pdfjsLib.GlobalWorkerOptions) {
        pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;
    }

    const extractPdfText = useCallback(async (file) => {
        const arrayBuffer = await file.arrayBuffer();
        const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
        const pdf = await loadingTask.promise;
        
        let fullText = '';
        for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const textContent = await page.getTextContent();
            fullText += textContent.items.map(item => item.str).join(' ') + '\n';
        }
        return fullText;
    }, []);

    const handleFileDrop = useCallback(async (file) => {
        if (isUploading) return;
        
        if (!file || file.type !== 'application/pdf') {
            setUploadError(new Error('Only PDF files are supported.'));
            return;
        }

        setIsUploading(true);
        setUploadStatus(`Processing ${file.name}...`);
        setUploadError(null);

        try {
            const pdfText = await extractPdfText(file);
            const formData = new FormData();
            formData.append('file', file);
            formData.append('pdfText', pdfText);
            const fileName = file.name; 

            setUploadStatus('Uploading text to server...');

            // --- API CALL 1: /api/upload-pdf ---
            let response = await fetch(`${API_BASE_URL}/api/upload-pdf`, {
                method: 'POST',
                body: formData,
            });
            
            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Upload failed (Status ${response.status}): ${errorText.substring(0, 100)}...`);
            }
            let result = await response.json();
            if (!result.success) {
                throw new Error(result.error || 'Server reported failure during PDF upload.');
            }

            setUploadStatus(`Successfully uploaded ${result.filename}. Starting conversation...`);
            
            // --- API CALL 2: /api/start-conversation ---
            response = await fetch(`${API_BASE_URL}/api/start-conversation`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId: result.sessionId }),
            });
            
            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Conversation start failed (Status ${response.status}): ${errorText.substring(0, 100)}...`);
            }
            result = await response.json();
            
            if (result.success) {
                onUploadSuccess({ 
                    sessionId: result.sessionId, 
                    filename: fileName,
                    initialMessage: result.message 
                });
            } else {
                throw new Error(result.error || 'Server reported failure starting conversation.');
            }
            
        } catch (error) {
            console.error('PDF handler error:', error);
            setUploadError(error);
            setUploadStatus(`Operation failed: ${error.message}`);
        } finally {
            setIsUploading(false);
        }
    }, [isUploading, extractPdfText, onUploadSuccess]);

    useEffect(() => {
        const handleDragOver = (e) => { e.preventDefault(); e.stopPropagation(); };
        const handleDrop = (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                handleFileDrop(e.dataTransfer.files[0]);
                e.dataTransfer.clearData();
            }
        };
        document.body.addEventListener('dragover', handleDragOver);
        document.body.addEventListener('drop', handleDrop);
        return () => {
            document.body.removeEventListener('dragover', handleDragOver);
            document.body.removeEventListener('drop', handleDrop);
        };
    }, [handleFileDrop]);

    return { isUploading, uploadStatus, uploadError };
}