import React, { useState } from 'react';

export default function LicenseModal({ licenseData, isOpen, onClose }) {
  if (!isOpen) return null;

  const [key, setKey] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const isExpired = licenseData?.status === 'TRIAL_EXPIRED';

  const handleActivate = async () => {
    setError('');
    setSuccess('');
    setIsLoading(true);
    try {
      const res = await fetch('/api/license/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setSuccess(data.message || 'License activated!');
        setTimeout(() => {
          onClose(); // Needs to trigger a reload or refresh of license status
        }, 1500);
      } else {
        setError(data.message || data.error || 'Invalid license key.');
      }
    } catch (err) {
      setError('Connection error. Could not activate.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[100] flex items-center justify-center p-4 animate-in fade-in duration-200">
      <div className="bg-[#1e1e1e] border border-[#333] rounded-lg shadow-2xl w-full max-w-md overflow-hidden flex flex-col">
        <div className="p-4 border-b border-[#333] flex justify-between items-center bg-[#252526]">
          <h2 className="text-lg font-semibold text-[#e8e8e8]">
            {isExpired ? 'Trial Expired' : 'Activate OpalaTex'}
          </h2>
          {!isExpired && (
            <button onClick={onClose} className="text-[#858585] hover:text-[#e8e8e8] transition-colors">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path></svg>
            </button>
          )}
        </div>
        
        <div className="p-6 space-y-4">
          <p className="text-sm text-[#cccccc]">
            {isExpired 
              ? 'Your 14-day free trial has expired. To continue using OpalaTex, please enter a valid license key.'
              : 'Enter your license key to activate OpalaTex and unlock all features.'}
          </p>
          
          <div>
            <label className="block text-xs text-[#858585] mb-1 uppercase tracking-wider">License Key</label>
            <input
              type="text"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="OPALA-XXXX-XXXX-XXXX"
              className="w-full bg-[#3c3c3c] text-[#cccccc] border border-[#444] rounded px-3 py-2 text-sm focus:outline-none focus:border-[#007acc] transition-colors font-mono"
              autoFocus
            />
          </div>

          {error && <div className="text-red-400 text-xs p-2 bg-red-400/10 rounded">{error}</div>}
          {success && <div className="text-green-400 text-xs p-2 bg-green-400/10 rounded">{success}</div>}
        </div>
        
        <div className="p-4 bg-[#252526] border-t border-[#333] flex justify-end gap-2">
          {!isExpired && (
            <button onClick={onClose} className="px-4 py-2 text-sm text-[#cccccc] hover:bg-[#3c3c3c] rounded transition-colors">
              Cancel
            </button>
          )}
          <button 
            onClick={handleActivate}
            disabled={!key.trim() || isLoading}
            className="px-4 py-2 text-sm bg-[#0e639c] text-white rounded hover:bg-[#1177bb] disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium shadow-sm"
          >
            {isLoading ? 'Activating...' : 'Activate License'}
          </button>
        </div>
      </div>
    </div>
  );
}
