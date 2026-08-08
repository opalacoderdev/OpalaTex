import { useRef, useState, useCallback, useLayoutEffect, useEffect } from 'react';
import { MessageSquare, Cpu, HelpCircle, Check, X, ArrowRight, Eraser, Globe, Settings, Settings2, Plus, Trash2, Search, Paperclip, FileText, ZoomIn, ZoomOut, Download, Printer, GitBranch, RefreshCw, Pencil, Sparkles, MoreHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useCustomDialog } from './modals/CustomDialogProvider';
import { formatMessageContent } from '../utils/formatMessage';
import { readClipboard } from '../utils/clipboard.js';
import { useTextContextMenu } from '../hooks/useTextContextMenu.js';
import TextContextMenu from './TextContextMenu.jsx';
import SearchChatsModal from './modals/SearchChatsModal.jsx';
import { FEATURES } from '../config/features';

const normalizeForErrorMatch = (value) => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase();

const stripThinkBlocksForErrorMatch = (content = '') => (
  String(content || '').replace(/<think>[\s\S]*?(<\/think>|$)/gi, '')
);

const isRetryableAssistantErrorMessage = (msg, displayContent) => {
  if (msg?.is_error === true) return true;
  const raw = stripThinkBlocksForErrorMatch(displayContent || msg?.content || '');
  const normalized = normalizeForErrorMatch(raw);
  const start = normalized.replace(/^[^\p{L}\p{N}]+/u, '');
  return (
    normalized.includes('agent error') ||
    normalized.includes('erro do agente') ||
    start.startsWith('error:') ||
    start.startsWith('erro:') ||
    start.startsWith('failed') ||
    start.startsWith('failure') ||
    start.startsWith('falha') ||
    normalized.includes('cota de uso') ||
    normalized.includes('creditos suficientes') ||
    normalized.includes('insufficient ai credits') ||
    normalized.includes('critical worker crash') ||
    normalized.includes('err_connection_failed')
  );
};

const isHiddenChatSystemMessage = (msg) => (
  msg?.role === 'system' &&
  (
    String(msg?.content || '').startsWith('[MODE] ') ||
    String(msg?.content || '').startsWith('[PLAN APPROVED] ') ||
    String(msg?.content || '').startsWith('[PLAN REJECTED] ') ||
    String(msg?.content || '').startsWith('Achievements logged during this turn:')
  )
);

const numericMessageId = (message) => {
  if (message?.id === undefined || message?.id === null || message.id === '') return null;
  const parsed = Number(message.id);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const modelOptionLabel = (model, models) => {
  const name = model.name || model.id;
  const matchingModels = models.filter(candidate => (candidate.name || candidate.id) === name);
  if (matchingModels.length < 2) return name;

  return `${name} #${matchingModels.findIndex(candidate => candidate.id === model.id) + 1}`;
};
// Right-side chat panel for interacting with the OpalaTex agent.
export default function ChatPanel({
  chatMessages,
  chatInput,
  setChatInput,
  isAgentRunning,
  isInterruptPending = false,
  chatThoughtStream,
  chatResponseStream,
  activeProject,
  isChatVisible,
  setIsChatVisible,
  chatWidth,
  handleSendMessage,
  onEditUserMessage,
  onGenerateResponseForUserMessage,
  handleInterruptAgent,
  chatEndRef,
  onClearChat,
  webSearchConfig,
  setWebSearchConfig,
  activeChatId,
  setActiveChatId,
  chats,
  setChats,
  setChatMessages,
  onSwitchChat,
  pendingAttachments,
  setPendingAttachments,
  isChatMode,
  globalModels = [],
  onRefreshModels,
  onEditModels,
  onModelChange,
  globalAiProvider
}) {
  const { t } = useTranslation();
  const { showPrompt, showAlert, showConfirm } = useCustomDialog();
  const historyRef = useRef(null);
  const inputRef = useRef(null);
  const fileInputRef = useRef(null);
  const chatActionsMenuRef = useRef(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const [showChatActionsMenu, setShowChatActionsMenu] = useState(false);
  const [isEvolvingPrompt, setIsEvolvingPrompt] = useState(false);
  const [evolutionProgress, setEvolutionProgress] = useState(null);
  const { menu, onContextMenu, handleCopy, handleSelectAll, close: closeMenu } = useTextContextMenu();

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }, [chatInput]);

  useEffect(() => {
    if (isAgentRunning && (chatThoughtStream || chatResponseStream) && chatEndRef?.current) {
      chatEndRef.current.scrollIntoView();
    }
  }, [chatThoughtStream, chatResponseStream, isAgentRunning, chatEndRef]);

  useEffect(() => {
    if (!showChatActionsMenu) return;
    const handlePointerDown = (event) => {
      if (!chatActionsMenuRef.current?.contains(event.target)) {
        setShowChatActionsMenu(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [showChatActionsMenu]);

  const handlePaste = useCallback(() => {
    readClipboard().then((text) => {
      if (!text) return;
      const el = inputRef.current;
      if (el) {
        const start = el.selectionStart ?? chatInput.length;
        const end = el.selectionEnd ?? chatInput.length;
        const next = chatInput.slice(0, start) + text + chatInput.slice(end);
        setChatInput(next);
        requestAnimationFrame(() => {
          el.focus();
          const pos = start + text.length;
          el.setSelectionRange(pos, pos);
        });
      } else {
        setChatInput((prev) => prev + text);
      }
    });
    closeMenu();
  }, [chatInput, setChatInput, closeMenu]);

  const [hideThink, setHideThink] = useState(() => {
    const stored = localStorage.getItem('chatHideThink');
    return stored === null ? false : stored === 'true';
  });

  // Chat input history state
  const [inputHistory, setInputHistory] = useState(() => {
    try {
      const saved = localStorage.getItem('chatInputHistory');
      return saved ? JSON.parse(saved) : [];
    } catch (_) {
      return [];
    }
  });
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [tempInput, setTempInput] = useState('');
  // MCP config panel state
  const [showMcpPanel, setShowMcpPanel] = useState(false);
  const [mcpUrlDraft, setMcpUrlDraft] = useState('');
  const [mcpToolDraft, setMcpToolDraft] = useState('web_search');
  const [mcpApiKeyDraft, setMcpApiKeyDraft] = useState('');
  const [useMcpDraft, setUseMcpDraft] = useState(false);
  const [chatZoom, setChatZoom] = useState(() => {
    const saved = localStorage.getItem('chatZoom');
    const parsed = saved !== null ? Number(saved) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
  });
  const [mcpTestStatus, setMcpTestStatus] = useState(''); // '', 'testing', 'ok', 'error:<msg>'

  // Font magnifier helpers
  const MIN_ZOOM = 0.5;
  const MAX_ZOOM = 2.5;
  const ZOOM_STEP = 0.1;
  const applyChatZoom = useCallback((next) => {
    const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(next * 10) / 10));
    setChatZoom(clamped);
    localStorage.setItem('chatZoom', String(clamped));
  }, []);
  const zoomIn = useCallback(() => applyChatZoom(chatZoom + ZOOM_STEP), [applyChatZoom, chatZoom]);
  const zoomOut = useCallback(() => applyChatZoom(chatZoom - ZOOM_STEP), [applyChatZoom, chatZoom]);
  const zoomReset = useCallback(() => applyChatZoom(1), [applyChatZoom]);

  // Custom prompt state for new chat
  const [showNewChatPrompt, setShowNewChatPrompt] = useState(false);
  const [newChatName, setNewChatName] = useState('');
  const [showSearchModal, setShowSearchModal] = useState(false);
  const [editingMessageIndex, setEditingMessageIndex] = useState(null);
  const [editingMessageDraft, setEditingMessageDraft] = useState('');

  // Custom confirm state for deleting chat
  const [chatToDelete, setChatToDelete] = useState(null);

  // globalAiProvider is received as a prop from App.jsx

  const getPromptEvolutionErrorMessage = useCallback((error) => {
    const raw = error instanceof Error ? error.message : String(error || '');
    const normalized = raw.toLowerCase();

    if (normalized.includes('valid structured result')) {
      return t('chatPanel.evolveInvalidStructuredResult');
    }
    if (normalized.includes('internal task wrapper')) {
      return t('chatPanel.evolveInternalWrapperResult');
    }
    if (normalized.includes('original prompt unchanged')) {
      return t('chatPanel.evolveOriginalUnchanged');
    }
    if (normalized.includes('internal instructions')) {
      return t('chatPanel.evolveInternalInstructionLeak');
    }
    if (normalized.includes('empty refined prompt')) {
      return t('chatPanel.evolveEmptyResult');
    }
    if (!raw || normalized === 'evolution failed') {
      return t('chatPanel.evolveGenericFailure');
    }
    return raw;
  }, [t]);
  const handleEvolvePrompt = async () => {
    const rawPrompt = chatInput.trim();
    if (!rawPrompt || isAgentRunning || isEvolvingPrompt || !activeProject) return;

    setIsEvolvingPrompt(true);
    setEvolutionProgress({ active: true, iteration: 1, total: 1, complete: false });

    try {
      const res = await fetch('/api/chat/evolve-prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
        body: JSON.stringify({
          prompt: rawPrompt,
          model: globalAiProvider === 'cloud' ? null : activeProject.model,
          project_path: activeProject?.path || activeProject?.project_name,
          stream: true,
        }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || t('statusBar.networkError', { message: res.statusText }));
      }

      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const data = await res.json();
        if (data.prompt) {
          setChatInput(data.prompt);
        }
      } else if (res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';
        let currentEvent = 'message';
        let isFirstChunkInIter = true;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            if (trimmed.startsWith('event:')) {
              currentEvent = trimmed.slice(6).trim();
            } else if (trimmed.startsWith('data:')) {
              const dataStr = trimmed.slice(5).trim();
              try {
                const payload = JSON.parse(dataStr);
                if (currentEvent === 'iteration_start') {
                  isFirstChunkInIter = true;
                  setEvolutionProgress({
                    active: true,
                    iteration: payload.iteration,
                    total: payload.total_iterations,
                    complete: false,
                  });
                } else if (currentEvent === 'chunk') {
                  if (payload.text) {
                    if (isFirstChunkInIter) {
                      setChatInput(payload.text);
                      isFirstChunkInIter = false;
                    } else {
                      setChatInput(prev => prev + payload.text);
                    }
                  }
                } else if (currentEvent === 'iteration_end') {
                  if (payload.prompt) {
                    setChatInput(payload.prompt);
                  }
                } else if (currentEvent === 'complete') {
                  if (payload.prompt) {
                    setChatInput(payload.prompt);
                  }
                } else if (currentEvent === 'error') {
                  throw new Error(payload.error || t('chatPanel.evolveGenericFailure'));
                }
              } catch (e) {
                if (currentEvent === 'error') throw e;
              }
            }
          }
        }
      }

      setEvolutionProgress(prev => ({ ...(prev || {}), active: false, complete: true }));
      setTimeout(() => setEvolutionProgress(null), 2200);

    } catch (err) {
      showAlert(t('chatPanel.evolveError', { message: getPromptEvolutionErrorMessage(err) }));
      setEvolutionProgress(null);
    } finally {
      setIsEvolvingPrompt(false);
    }
  };


  const searchEnabled = webSearchConfig?.enabled ?? true;

  const handleToggleWebSearch = async () => {
    const newEnabled = !searchEnabled;
    const updated = { ...webSearchConfig, enabled: newEnabled };
    setWebSearchConfig(updated);
    try {
      await fetch('/api/settings/web-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updated),
      });
    } catch (_) {}
  };

  const handleOpenMcp = () => {
    setMcpUrlDraft(webSearchConfig?.mcp_url || '');
    setMcpToolDraft(webSearchConfig?.mcp_tool || 'web_search');
    setMcpApiKeyDraft(webSearchConfig?.mcp_api_key || '');
    const provider = webSearchConfig?.provider;
    const isMcp = provider ? (provider === 'mcp') : !!(webSearchConfig?.mcp_url);
    setUseMcpDraft(isMcp);
    setMcpTestStatus('');
    setShowMcpPanel(p => !p);
  };

  const handleSaveMcp = async () => {
    const updated = {
      ...webSearchConfig,
      mcp_url: mcpUrlDraft.trim(),
      mcp_tool: mcpToolDraft.trim() || 'web_search',
      mcp_api_key: mcpApiKeyDraft.trim(),
      provider: useMcpDraft ? 'mcp' : 'duckduckgo',
    };
    setWebSearchConfig(updated);
    try {
      await fetch('/api/settings/web-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updated),
      });
      setShowMcpPanel(false);
    } catch (_) {}
  };

  const handleTestMcp = async () => {
    setMcpTestStatus('testing');
    try {
      const res = await fetch('/api/settings/web-search/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mcp_url: mcpUrlDraft.trim(),
          mcp_tool: mcpToolDraft.trim() || 'web_search',
          mcp_api_key: mcpApiKeyDraft.trim(),
        }),
      });
      const data = await res.json();
      setMcpTestStatus(data.ok ? 'ok' : `error:${data.error || 'Unknown error'}`);
    } catch (e) {
      setMcpTestStatus(`error:${e.message}`);
    }
  };

  const handleFormSubmit = (e) => {
    if (e) e.preventDefault();
    if ((!chatInput.trim() && (!pendingAttachments || pendingAttachments.length === 0)) || !activeProject || isAgentRunning) return;
    const text = chatInput.trim();
    if (text) {
      setInputHistory(prev => {
        if (prev[prev.length - 1] === text) return prev;
        const newHist = [...prev, text].slice(-100);
        try {
          localStorage.setItem('chatInputHistory', JSON.stringify(newHist));
        } catch (_) {}
        return newHist;
      });
    }
    setHistoryIndex(-1);
    setTempInput('');
    handleSendMessage(e);
  };

  const runChatAction = useCallback(async (action) => {
    try {
      await action();
    } catch (err) {
      const message = err?.message || String(err);
      console.error('Chat action failed:', err);
      showAlert?.(t('chatPanel.actionFailed', 'Could not start this chat action: {{message}}', { message }));
    }
  }, [showAlert, t]);

  const handleKeyDown = (e) => {
    // Font zoom shortcuts: Ctrl+= / Ctrl+Plus, Ctrl+-, Ctrl+0
    if (e.ctrlKey && !e.altKey && !e.metaKey) {
      if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        zoomIn();
        return;
      }
      if (e.key === '-') {
        e.preventDefault();
        zoomOut();
        return;
      }
      if (e.key === '0') {
        e.preventDefault();
        zoomReset();
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleFormSubmit(null);
    } else if (e.ctrlKey && !e.altKey && !e.metaKey && e.key === 'ArrowUp') {
      if (inputHistory.length === 0) return;
      e.preventDefault();
      const newIndex = historyIndex === -1
        ? inputHistory.length - 1
        : Math.max(0, historyIndex - 1);
      if (historyIndex === -1) setTempInput(chatInput);
      setHistoryIndex(newIndex);
      setChatInput(inputHistory[newIndex]);
    } else if (e.ctrlKey && !e.altKey && !e.metaKey && e.key === 'ArrowDown') {
      if (historyIndex === -1) return;
      e.preventDefault();
      if (historyIndex === inputHistory.length - 1) {
        setHistoryIndex(-1);
        setChatInput(tempInput);
      } else {
        const newIndex = historyIndex + 1;
        setHistoryIndex(newIndex);
        setChatInput(inputHistory[newIndex]);
      }
    } else if (e.key === 'Escape') {
      if (historyIndex !== -1) {
        e.preventDefault();
        setHistoryIndex(-1);
        setChatInput(tempInput);
      }
    }
  };

  const hasMcp = webSearchConfig?.provider === 'mcp' && !!(webSearchConfig?.mcp_url);

  // ---- Attachment helpers ----
  const supportedAttachmentMimes = new Set([
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ]);
  const supportedAttachmentExtensions = new Set(['.pdf', '.docx', '.pptx']);

  const getFileExtension = (filename = '') => {
    const dot = filename.lastIndexOf('.');
    return dot >= 0 ? filename.slice(dot).toLowerCase() : '';
  };

  const isSupportedAttachment = (file) => {
    const mime = file.type || '';
    return mime.startsWith('image/')
      || supportedAttachmentMimes.has(mime)
      || supportedAttachmentExtensions.has(getFileExtension(file.name));
  };

  const getUploadMime = (file) => {
    if (file.type) return file.type;
    const ext = getFileExtension(file.name);
    if (ext === '.pdf') return 'application/pdf';
    if (ext === '.docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    if (ext === '.pptx') return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    return 'application/octet-stream';
  };

  const uploadFile = async (file) => {
    const reader = new FileReader();
    return new Promise((resolve, reject) => {
      reader.onload = async (ev) => {
        const dataUrl = ev.target.result;
        const base64 = dataUrl.split(',')[1];
        try {
          const res = await fetch('/api/chat/upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              filename: file.name,
              data_b64: base64,
              mime: getUploadMime(file),
              project_name: activeProject?.name,
            }),
          });
          if (!res.ok) {
            let serverMsg = `Upload failed: ${res.status}`;
            try {
              const errBody = await res.json();
              if (errBody?.error) serverMsg = errBody.error;
            } catch (_) {}
            throw new Error(serverMsg);
          }
          const descriptor = await res.json();
          // keep original data URL for image preview in the UI
          descriptor._previewUrl = file.type?.startsWith('image/') ? dataUrl : null;
          resolve(descriptor);
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  };

  const processFiles = async (files) => {
    if (!files || files.length === 0) return;
    setUploadingFiles(true);
    const results = [];
    for (const f of Array.from(files)) {
      if (!isSupportedAttachment(f)) continue;
      try {
        const desc = await uploadFile(f);
        results.push(desc);
      } catch (err) {
        console.error('Attachment upload failed:', err);
        // Show the error in chat so the user knows why the attachment was not added
        setMessages(prev => [...(prev || []), {
          role: 'system',
          content: `⚠️ Attachment "${f.name}" could not be uploaded: ${err.message}`,
        }]);
      }
    }
    setPendingAttachments(prev => [...(prev || []), ...results]);
    setUploadingFiles(false);
  };

  const removeAttachment = (idx) => {
    setPendingAttachments(prev => prev.filter((_, i) => i !== idx));
  };

  const handleFileInputChange = (e) => {
    processFiles(e.target.files);
    e.target.value = '';
  };

  const handleDragOver = (e) => { e.preventDefault(); setIsDragOver(true); };
  const handleDragLeave = () => setIsDragOver(false);
  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragOver(false);
    processFiles(e.dataTransfer.files);
  };

  const handleCreateChatClick = () => {
    if (!activeProject) return;
    setNewChatName(`Chat ${chats.length + 1}`);
    setShowNewChatPrompt(true);
  };

  const submitNewChat = async (e) => {
    e?.preventDefault();
    if (!activeProject || !newChatName.trim()) return;

    try {
      const res = await fetch('/api/chat/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_name: activeProject.name, chat_name: newChatName.trim() })
      });
      if (!res.ok) throw new Error('Failed to create chat');
      const data = await res.json();
      setChats(prev => [...prev, data]);
      setActiveChatId(data.id);
      
      const greeting = activeProject.project_name || activeProject.name;
      setChatMessages([{ role: 'assistant', content: t('app.greeting', { projectName: greeting }) }]);
      setShowNewChatPrompt(false);
    } catch (e) {
      console.error(e);
    }
  };

  const handleCreateChat = async () => {
    // Legacy fallback, replaced by handleCreateChatClick
  };

  const handleDeleteChatClick = (id, e) => {
    e.stopPropagation();
    if (!activeProject || id === 'main') return;
    setChatToDelete(id);
  };

  const confirmDeleteChat = async () => {
    if (!activeProject || !chatToDelete || chatToDelete === 'main') return;
    const id = chatToDelete;
    
    try {
      const res = await fetch('/api/chat/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_name: activeProject.name, chat_id: id })
      });
      if (!res.ok) throw new Error('Failed to delete chat');
      const newChats = chats.filter(c => c.id !== id);
      setChats(newChats);
      if (activeChatId === id) {
        // Switch to main if we deleted the current one
        handleSwitchChat('main', newChats);
      }
      setChatToDelete(null);
    } catch (err) {
      console.error(err);
      setChatToDelete(null);
    }
  };

  const handleClearAllChats = async () => {
    if (!activeProject || isAgentRunning) return;

    setShowChatActionsMenu(false);
    const confirmed = await showConfirm(
      t('chatPanel.clearAllChatsConfirmation', 'This will permanently delete every chat and its history for this project. This cannot be undone.'),
      t('chatPanel.clearAllChatsTitle', 'Delete all chats')
    );
    if (!confirmed) return;

    try {
      const res = await fetch('/api/chat/clear-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_name: activeProject.name }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Request failed: ${res.status}`);

      const greeting = activeProject.project_name || activeProject.name;
      setChats([data.chat]);
      setActiveChatId(data.chat.id);
      localStorage.setItem(`lastChat_${activeProject.name}`, data.chat.id);
      setChatInput('');
      setPendingAttachments([]);
      setChatMessages([{ role: 'assistant', content: t('app.greeting', { projectName: greeting }) }]);
    } catch (err) {
      console.error('Failed to clear all chats:', err);
      showAlert(t('chatPanel.clearAllChatsFailed', 'Could not delete all chats: {{message}}', {
        message: err?.message || String(err),
      }));
    }
  };

  const handleSwitchChat = onSwitchChat;

  const handleExportMarkdown = () => {
    if (!chatMessages || chatMessages.length === 0) return;
    let md = `# Chat Export - ${activeProject?.name || 'OpalaTex'}\n\n`;
    chatMessages.filter(msg => !isHiddenChatSystemMessage(msg)).forEach(msg => {
      const role = msg.role === 'user' ? 'User' : 'OpalaTex';
      md += `### ${role}\n\n${msg.content}\n\n---\n\n`;
    });
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `chat_export_${new Date().toISOString().split('T')[0]}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleBranchChat = async (messageIndex, message) => {
    const newChatName = await showPrompt(t('chatPanel.branchPrompt', 'Name for the new chat (branch):'));
    if (!newChatName) return;
 
    try {
      const projectName = activeProject?.name || '';
      const persistedMessageIndex = chatMessages
        .slice(0, messageIndex + 1)
        .filter(msg => numericMessageId(msg) !== null)
        .length - 1;
      const selectedMessageId = numericMessageId(message);
      const selectedClientMessageId = String(message?.client_message_id || '').trim();
      const sourceChatId = message?.chat_id || activeChatId;
      const payload = {
        project_name: projectName,
        source_chat_id: sourceChatId,
        new_chat_name: newChatName,
      };
      if (persistedMessageIndex >= 0) {
        payload.message_index = persistedMessageIndex;
      }
      if (selectedMessageId !== null) {
        payload.message_id = selectedMessageId;
      } else if (selectedClientMessageId) {
        payload.client_message_id = selectedClientMessageId;
      }
      const res = await fetch('/api/chat/branch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      
      if (res.ok) {
        const data = await res.json();
        const listRes = await fetch(`/api/chat/list?project_name=${encodeURIComponent(projectName)}&t=${Date.now()}`);
        if (listRes.ok) {
          const listData = await listRes.json();
          setChats(listData.chats || []);
        }
        if (handleSwitchChat) {
          handleSwitchChat(data.new_chat_id);
        }
      } else {
        const err = await res.json();
        console.error('Failed to branch chat:', err.error);
        await showAlert(t('app.error', 'Erro:') + ' ' + (err.error || 'Failed to branch chat'));
      }
    } catch (e) {
      console.error(e);
      await showAlert(t('app.error', 'Erro:') + ' ' + e.message);
    }
  };

  const handleStartEditMessage = (messageIndex, message) => {
    setEditingMessageIndex(messageIndex);
    setEditingMessageDraft(message.content || '');
  };

  const handleCancelEditMessage = () => {
    setEditingMessageIndex(null);
    setEditingMessageDraft('');
  };

  const handleSubmitEditMessage = async (messageIndex, message) => {
    const nextContent = editingMessageDraft.trim();
    if (!nextContent || nextContent === message.content) {
      handleCancelEditMessage();
      return;
    }
    await onEditUserMessage?.(messageIndex, message, nextContent);
    handleCancelEditMessage();
  };

  const handleExportSingleMessage = (content) => {
    if (!content) return;
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    // Use ISO string but make it filename-safe
    const timeStr = new Date().toISOString().replace(/[:.]/g, '-');
    a.download = `agent_response_${timeStr}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };


  const handlePrintPDF = () => {
    document.body.classList.remove('printing-editor');
    window.print();
  };

  const contentWithoutThink = (content = '') => (
    String(content).replace(/<think>[\s\S]*?(<\/think>|$)/gi, '').trim()
  );

  const isInternalResumePrompt = (content = '') => {
    const text = String(content).trim();
    return (
      text.startsWith('Continue the task that was interrupted. Do not restart from scratch.') &&
      text.includes('## Captured agent activity before interruption')
    );
  };

  const modelSelectorGroupStyle = {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    flex: '1 1 260px',
    minWidth: 0,
    maxWidth: '100%',
    flexWrap: 'wrap',
  };
  const modelSelectorLabelStyle = {
    fontSize: '11px',
    color: 'var(--vscode-descriptionForeground)',
    flex: '0 0 auto',
    whiteSpace: 'nowrap',
  };
  const modelSelectorInputStyle = {
    flex: '1 1 150px',
    minWidth: 0,
    maxWidth: '100%',
    padding: '2px 4px',
    fontSize: '11px',
    height: '22px',
  };

  // Token battery calculation
  const numCtx = parseInt(activeProject?.model_params?.num_ctx || activeProject?.agent_params?.max_context_tokens || 8192, 10);
  const estimatedTokens = chatMessages.reduce((acc, msg) => acc + Math.ceil((msg.content?.length || 0) / 4), 0);
  const availableTokens = Math.max(0, numCtx - estimatedTokens);
  const tokenPercentage = Math.min(100, Math.max(0, (availableTokens / numCtx) * 100));
  const isTokenExploded = availableTokens === 0;
  // Cheia (verde), perto do limite (amarela), explodiu (vermelha)
  const batteryColor = isTokenExploded ? 'var(--battery-exploded)' : tokenPercentage <= 20 ? 'var(--battery-low)' : 'var(--battery-good)';

  if (!isChatVisible) return null;

  return (
    <aside 
      className="vscode-chat" 
      style={isChatMode ? { flex: 1, borderLeft: 'none', width: '100%' } : { width: `${chatWidth}px` }}
    >
      <TextContextMenu
        menu={menu}
        onCopy={handleCopy}
        onPaste={handlePaste}
        onSelectAll={() => handleSelectAll(historyRef)}
      />
      {/* Header */}
      <div className="vscode-chat-header">
        <span className="vscode-sidebar-title" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <MessageSquare size={12} style={{ color: '#007acc' }} />
          <span>{t('chatPanel.header')}</span>
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div 
            title={`Contexto: ${availableTokens} disponíveis / ${numCtx} total`}
            style={{ 
              display: 'flex', alignItems: 'center', gap: '4px', 
              marginRight: '8px', cursor: 'help',
              opacity: 0.9,
              fontSize: '10px',
              color: batteryColor
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '1px' }}>
              <div style={{
                width: '16px', height: '9px', 
                border: `1px solid ${batteryColor}`, 
                borderRadius: '2px', 
                padding: '1px',
                display: 'flex'
              }}>
                <div style={{
                  width: `${Math.min(100, tokenPercentage)}%`, 
                  backgroundColor: batteryColor, 
                  height: '100%', 
                  transition: 'width 0.3s'
                }} />
              </div>
              <div style={{
                width: '2px', height: '3px', 
                backgroundColor: batteryColor, 
                borderRadius: '0 1px 1px 0'
              }} />
            </div>
            <span>{Math.round(tokenPercentage)}%</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginRight: '4px' }}>
            <input 
              type="checkbox" 
              id="hide-think-cb" 
              checked={hideThink}
              onChange={e => {
                const val = e.target.checked;
                setHideThink(val);
                localStorage.setItem('chatHideThink', val);
              }}
              style={{ cursor: 'pointer', margin: 0 }}
              title={t('chatPanel.hideThinkTooltip', 'Ocultar blocos <think> do chat')}
            />
            <label htmlFor="hide-think-cb" style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)', cursor: 'pointer', userSelect: 'none' }} title={t('chatPanel.hideThinkTooltip', 'Ocultar blocos <think> do chat')}>
              {t('chatPanel.hideThink', 'Hide Think')}
            </label>
          </div>
          <button
            onClick={zoomOut}
            disabled={chatZoom <= MIN_ZOOM + 1e-9}
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--vscode-text-fg)', opacity: chatZoom <= MIN_ZOOM + 1e-9 ? 0.4 : 1 }}
            title={t('chatPanel.zoomOut', 'Diminuir Zoom')}
          >
            <ZoomOut size={14} />
          </button>
          <button
            onClick={zoomReset}
            style={{
              background: 'transparent', border: '1px solid var(--vscode-border, #3c3c3c)',
              borderRadius: '3px', cursor: 'pointer', color: 'var(--vscode-text-fg)',
              fontSize: '10px', lineHeight: 1, padding: '2px 5px', minWidth: '34px',
            }}
            title={t('chatPanel.zoomReset', 'Restaurar Zoom')}
          >
            {Math.round(chatZoom * 100)}%
          </button>
          <button
            onClick={zoomIn}
            disabled={chatZoom >= MAX_ZOOM - 1e-9}
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--vscode-text-fg)', opacity: chatZoom >= MAX_ZOOM - 1e-9 ? 0.4 : 1 }}
            title={t('chatPanel.zoomIn', 'Aumentar Zoom')}
          >
            <ZoomIn size={14} />
          </button>
          <div ref={chatActionsMenuRef} className="vscode-overflow-menu-wrap">
            <button
              onClick={() => setShowChatActionsMenu(prev => !prev)}
              className="vscode-bottom-panel-clear-btn"
              style={{ padding: '4px' }}
              title={t('chatPanel.moreActions', 'Mais acoes')}
              aria-label={t('chatPanel.moreActions', 'Mais acoes')}
              aria-expanded={showChatActionsMenu}
            >
              <MoreHorizontal size={14} />
            </button>
            {showChatActionsMenu && (
              <div className="vscode-overflow-menu" role="menu">
                <button
                  type="button"
                  className="vscode-overflow-menu-item"
                  onClick={() => {
                    handleExportMarkdown();
                    setShowChatActionsMenu(false);
                  }}
                  role="menuitem"
                >
                  <Download size={14} />
                  <span>{t('chatPanel.exportMarkdown', 'Exportar como Markdown')}</span>
                </button>
                <button
                  type="button"
                  className="vscode-overflow-menu-item"
                  onClick={() => {
                    handlePrintPDF();
                    setShowChatActionsMenu(false);
                  }}
                  role="menuitem"
                >
                  <Printer size={14} />
                  <span>{t('chatPanel.exportPDF', 'Exportar como PDF / Imprimir')}</span>
                </button>
                <button
                  type="button"
                  className="vscode-overflow-menu-item"
                  onClick={() => {
                    onClearChat?.();
                    setShowChatActionsMenu(false);
                  }}
                  role="menuitem"
                >
                  <Eraser size={14} />
                  <span>{t('chatPanel.clearChat')}</span>
                </button>
                <button
                  type="button"
                  className="vscode-overflow-menu-item"
                  onClick={handleClearAllChats}
                  disabled={!activeProject || isAgentRunning}
                  role="menuitem"
                >
                  <Trash2 size={14} />
                  <span>{t('chatPanel.clearAllChats')}</span>
                </button>
              </div>
            )}
          </div>
          {!isChatMode && (
            <button
              onClick={() => setIsChatVisible(false)}
              style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--vscode-text-fg)' }}
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>
      
      {/* Chat Selector Toolbar - Only shown in IDE mode */}
      {!isChatMode && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 10px', borderBottom: '1px solid var(--vscode-border)', background: 'var(--vscode-sidebar-bg)', minHeight: '28px', gap: '6px' }}>
          <select 
            className="vscode-settings-input" 
            value={activeChatId} 
            onChange={(e) => handleSwitchChat(e.target.value)}
            style={{ flex: 1, padding: '2px 4px', fontSize: '11px', height: '22px' }}
          >
            {chats.map(c => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <div style={{ display: 'flex', gap: '4px' }}>
            <button onClick={() => setShowSearchModal(true)} title={t('chat.searchChats', 'Search Chats')} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--vscode-text-fg)', display: 'flex', alignItems: 'center', padding: '2px' }}>
              <Search size={14} />
            </button>
            <button onClick={handleCreateChatClick} title={t('chatSidebar.newChat', 'Novo Chat')} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#4ec9b0', display: 'flex', alignItems: 'center', padding: '2px' }}>
              <Plus size={14} />
            </button>
            {activeChatId !== 'main' && (
              <button onClick={(e) => handleDeleteChatClick(activeChatId, e)} title={t('chatPanel.deleteCurrentChat', 'Deletar Chat Atual')} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#f87171', display: 'flex', alignItems: 'center', padding: '2px' }}>
                <Trash2 size={14} />
              </button>
            )}
          </div>
        </div>
      )}

      {chatToDelete && (
        <div style={{ padding: '8px', borderBottom: '1px solid var(--vscode-border)', background: 'var(--vscode-sidebar-bg)', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <span style={{ fontSize: '11px', color: 'var(--vscode-text-fg)' }}>{t('chatSidebar.deletePrompt', 'Deletar este chat e todo o seu histórico?')}</span>
          <div style={{ display: 'flex', gap: '6px' }}>
            <button onClick={confirmDeleteChat} className="vscode-button" style={{ height: '24px', padding: '0 8px', fontSize: '11px', background: '#f87171', color: '#fff', border: 'none' }}>
              {t('chatSidebar.delete', 'Deletar')}
            </button>
            <button onClick={() => setChatToDelete(null)} className="vscode-button" style={{ height: '24px', padding: '0 8px', fontSize: '11px', background: 'transparent', color: 'var(--vscode-text-fg)', border: '1px solid var(--vscode-border)' }}>
              {t('chatSidebar.cancel', 'Cancelar')}
            </button>
          </div>
        </div>
      )}

      {showSearchModal && (
        <SearchChatsModal
          onClose={() => setShowSearchModal(false)}
          activeProject={activeProject?.name}
          onSwitchChat={handleSwitchChat}
        />
      )}

      {showNewChatPrompt && (
        <div style={{ padding: '8px', borderBottom: '1px solid var(--vscode-border)', background: 'var(--vscode-sidebar-bg)' }}>
          <form onSubmit={submitNewChat} style={{ display: 'flex', gap: '6px' }}>
            <input 
              autoFocus
              className="vscode-settings-input"
              value={newChatName}
              onChange={e => setNewChatName(e.target.value)}
              placeholder={t('chatSidebar.chatName', 'Nome do chat')}
              style={{ flex: 1, height: '24px', fontSize: '11px' }}
            />
            <button type="submit" className="vscode-button" style={{ height: '24px', padding: '0 8px', fontSize: '11px' }}>
              {t('chatSidebar.create', 'Criar')}
            </button>
            <button type="button" onClick={() => setShowNewChatPrompt(false)} className="vscode-button" style={{ height: '24px', padding: '0 8px', fontSize: '11px', background: 'transparent', color: 'var(--vscode-text-fg)', border: '1px solid var(--vscode-border)' }}>
              {t('chatSidebar.cancel', 'Cancelar')}
            </button>
          </form>
        </div>
      )}

      {/* Model selectors toolbar */}
      <div className="vscode-chat-toolbar" style={{ display: 'flex', gap: '8px', padding: '6px 10px', flexWrap: 'wrap' }}>
        <div style={modelSelectorGroupStyle}>
          <Settings2 size={12} style={{ color: 'var(--vscode-descriptionForeground)' }} />
          <span style={modelSelectorLabelStyle}>{t('chatPanel.orchestrator', 'Orchestrator')}:</span>
          {FEATURES.enableCloudModels && globalAiProvider === 'cloud' ? (
            <select
              className="vscode-settings-input"
              style={{ ...modelSelectorInputStyle, opacity: 0.8 }}
              disabled
            >
              <option>{t('topBar.opalaCloud')}</option>
            </select>
          ) : (
            <select
              className="vscode-settings-input"
              style={modelSelectorInputStyle}
              value={activeProject?.model || ''}
              onChange={(e) => {
                const val = e.target.value;
                if (val === 'edit_models') onEditModels?.();
                else if (val === 'refresh_models') onRefreshModels?.();
                else onModelChange?.('model', val);
              }}
              disabled={!activeProject}
              title={(globalModels || []).find(m => m.id === activeProject?.model)?.api_base ? `${t('editModelsModal.apiBaseUrl', 'API Base URL')}: ${(globalModels || []).find(m => m.id === activeProject?.model).api_base}` : undefined}
            >
              {(!activeProject || !activeProject.model) && <option value="">{t('chatPanel.selectModel')}</option>}
              {Object.entries((globalModels || []).reduce((acc, m) => { const p = m.provider || 'custom'; if (!acc[p]) acc[p] = []; acc[p].push(m); return acc; }, {})).map(([provider, models]) => (
                <optgroup key={`orch-${provider}`} label={provider.toUpperCase()}>
                  {models.map(m => <option key={`orch-${m.id}`} value={m.id} title={m.api_base ? `${t('editModelsModal.apiBaseUrl', 'API Base URL')}: ${m.api_base}` : undefined}>{modelOptionLabel(m, models)}</option>)}
                </optgroup>
              ))}
              <optgroup label={t('common.actions', 'Actions')}>
                <option value="refresh_models">🔄 {t('chatPanel.refreshModels', 'Refresh Models')}</option>
                <option value="edit_models">⚙️ {t('chatPanel.editModels', 'Edit Models...')}</option>
              </optgroup>
            </select>
          )}
        </div>
        <div style={modelSelectorGroupStyle}>
          <Cpu size={12} style={{ color: 'var(--vscode-descriptionForeground)' }} />
          <span style={modelSelectorLabelStyle}>{t('chatPanel.worker', 'Worker')}:</span>
          {FEATURES.enableCloudModels && globalAiProvider === 'cloud' ? (
            <select
              className="vscode-settings-input"
              style={{ ...modelSelectorInputStyle, opacity: 0.8 }}
              disabled
            >
              <option>{t('topBar.opalaCloud')}</option>
            </select>
          ) : (
            <select
              className="vscode-settings-input"
              style={modelSelectorInputStyle}
              value={activeProject?.worker_model || ''}
              onChange={(e) => {
                const val = e.target.value;
                if (val === 'edit_models') onEditModels?.();
                else if (val === 'refresh_models') onRefreshModels?.();
                else onModelChange?.('worker_model', val);
              }}
              disabled={!activeProject}
              title={(globalModels || []).find(m => m.id === activeProject?.worker_model)?.api_base ? `${t('editModelsModal.apiBaseUrl', 'API Base URL')}: ${(globalModels || []).find(m => m.id === activeProject?.worker_model).api_base}` : undefined}
            >
              {(!activeProject || !activeProject.worker_model) && <option value="">{t('chatPanel.selectModel')}</option>}
              {Object.entries((globalModels || []).reduce((acc, m) => { const p = m.provider || 'custom'; if (!acc[p]) acc[p] = []; acc[p].push(m); return acc; }, {})).map(([provider, models]) => (
                <optgroup key={`work-${provider}`} label={provider.toUpperCase()}>
                  {models.map(m => <option key={`work-${m.id}`} value={m.id} title={m.api_base ? `${t('editModelsModal.apiBaseUrl', 'API Base URL')}: ${m.api_base}` : undefined}>{modelOptionLabel(m, models)}</option>)}
                </optgroup>
              ))}
              <optgroup label={t('common.actions', 'Actions')}>
                <option value="refresh_models">🔄 {t('chatPanel.refreshModels', 'Refresh Models')}</option>
                <option value="edit_models">⚙️ {t('chatPanel.editModels', 'Edit Models...')}</option>
              </optgroup>
            </select>
          )}
        </div>
      </div>

      {/* Web Search toggle bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '4px 10px',
          borderBottom: '1px solid var(--vscode-border)',
          background: 'var(--vscode-sidebar-bg)',
          minHeight: '28px',
          gap: '6px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Globe size={12} style={{ color: searchEnabled ? '#4ec9b0' : '#888' }} />
          <span style={{ fontSize: '11px', color: searchEnabled ? 'var(--vscode-text-fg)' : '#888', userSelect: 'none' }}>
            {t('chatPanel.webSearch')}
            {hasMcp && searchEnabled && (
              <span style={{ marginLeft: '4px', fontSize: '10px', color: '#888' }}>{t('chatPanel.mcpIndicator')}</span>
            )}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          {/* Settings / MCP gear button */}
          <button
            onClick={handleOpenMcp}
            title={t('chatPanel.configureMcp')}
            style={{
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              color: showMcpPanel ? '#4ec9b0' : '#888',
              padding: '1px',
              display: 'flex',
              alignItems: 'center',
            }}
          >
            <Settings size={11} />
          </button>
          {/* Toggle switch */}
          <button
            id="web-search-toggle"
            onClick={handleToggleWebSearch}
            title={searchEnabled ? t('chatPanel.disableWebSearch') : t('chatPanel.enableWebSearch')}
            style={{
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              padding: '0',
              display: 'flex',
              alignItems: 'center',
            }}
          >
            <div
              style={{
                width: '28px',
                height: '14px',
                borderRadius: '7px',
                background: searchEnabled ? '#4ec9b0' : '#a0a0a0',
                position: 'relative',
                transition: 'background 0.2s',
              }}
            >
              <div
                style={{
                  width: '10px',
                  height: '10px',
                  borderRadius: '50%',
                  background: '#fff',
                  position: 'absolute',
                  top: '2px',
                  left: searchEnabled ? '16px' : '2px',
                  transition: 'left 0.2s',
                }}
              />
            </div>
          </button>
        </div>
      </div>

      {/* MCP config panel (inline, collapsible) */}
      {showMcpPanel && (
        <div
          style={{
            padding: '8px 10px',
            borderBottom: '1px solid var(--vscode-border)',
            background: 'var(--vscode-sidebar-bg)',
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
            <input
              id="use-mcp-checkbox"
              type="checkbox"
              checked={useMcpDraft}
              onChange={e => setUseMcpDraft(e.target.checked)}
              style={{ cursor: 'pointer' }}
            />
            <label htmlFor="use-mcp-checkbox" style={{ fontSize: '11px', color: '#ccc', cursor: 'pointer', userSelect: 'none' }}>
              {t('chatPanel.useMcpServer')}
            </label>
          </div>

          <label style={{ fontSize: '10px', color: useMcpDraft ? '#aaa' : '#555' }}>{t('chatPanel.serverUrl')}</label>
          <input
            id="mcp-url-input"
            type="text"
            value={mcpUrlDraft}
            disabled={!useMcpDraft}
            onChange={e => { setMcpUrlDraft(e.target.value); setMcpTestStatus(''); }}
            placeholder={t('chatPanel.mcpUrlPlaceholder')}
            className="vscode-settings-input"
            style={{
              fontSize: '11px',
              padding: '3px 6px',
            }}
          />

          <label style={{ fontSize: '10px', color: useMcpDraft ? '#aaa' : '#555' }}>{t('chatPanel.toolName')}</label>
          <input
            id="mcp-tool-input"
            type="text"
            value={mcpToolDraft}
            disabled={!useMcpDraft}
            onChange={e => { setMcpToolDraft(e.target.value); setMcpTestStatus(''); }}
            placeholder={t('chatPanel.mcpToolPlaceholder')}
            className="vscode-settings-input"
            style={{
              fontSize: '11px',
              padding: '3px 6px',
            }}
          />

          <label style={{ fontSize: '10px', color: useMcpDraft ? '#aaa' : '#555' }}>{t('chatPanel.apiKeyOptional')}</label>
          <input
            id="mcp-api-key-input"
            type="password"
            value={mcpApiKeyDraft}
            disabled={!useMcpDraft}
            onChange={e => { setMcpApiKeyDraft(e.target.value); setMcpTestStatus(''); }}
            placeholder={t('chatPanel.mcpApiKeyPlaceholder')}
            className="vscode-settings-input"
            style={{
              fontSize: '11px',
              padding: '3px 6px',
            }}
          />

          <div style={{ display: 'flex', gap: '6px', alignItems: 'center', marginTop: '2px' }}>
            <button
              id="mcp-test-btn"
              onClick={handleTestMcp}
              disabled={!useMcpDraft || !mcpUrlDraft.trim() || mcpTestStatus === 'testing'}
              className="vscode-button"
              style={{
                fontSize: '10px',
                padding: '3px 8px',
                background: 'transparent',
                border: '1px solid var(--vscode-border)',
                color: 'var(--vscode-text-fg)',
              }}
            >
              {mcpTestStatus === 'testing' ? '...' : t('chatPanel.test')}
            </button>
            <button
              id="mcp-save-btn"
              onClick={handleSaveMcp}
              className="vscode-button"
              style={{
                fontSize: '10px',
                padding: '3px 8px',
              }}
            >
              {t('chatPanel.save')}
            </button>
            <button
              onClick={() => { setShowMcpPanel(false); setMcpTestStatus(''); }}
              className="vscode-button"
              style={{
                fontSize: '10px',
                padding: '3px 6px',
                background: 'transparent',
                border: 'none',
                color: 'var(--vscode-text-fg)',
              }}
            >
              {t('chatPanel.cancel')}
            </button>
          </div>

          {/* Test result */}
          {mcpTestStatus && mcpTestStatus !== 'testing' && (
            <div
              style={{
                fontSize: '10px',
                color: mcpTestStatus === 'ok' ? '#4ec9b0' : '#f48771',
                marginTop: '2px',
              }}
            >
              {mcpTestStatus === 'ok'
                ? t('chatPanel.connectionOk')
                : t('chatPanel.connectionError', { error: mcpTestStatus.replace('error:', '') })}
            </div>
          )}
        </div>
      )}

      {/* Message history */}
      <div className="vscode-chat-history" ref={historyRef} onContextMenu={onContextMenu} style={{ zoom: chatZoom, ['--chat-font-scale']: chatZoom }}>
        {chatMessages.map((msg, i) => {
          if (isHiddenChatSystemMessage(msg)) {
            return null;
          }

          const isSystem = msg.role === 'system';
          if (isSystem) {
            const isLastSystemAfterUserOnly = i === chatMessages.length - 1 && !chatMessages.slice(i + 1).some(m => m.role === 'user' || m.role === 'assistant');
            let previousUserMsg = null;
            if (isLastSystemAfterUserOnly) {
              for (let j = i - 1; j >= 0; j--) {
                if (chatMessages[j].role === 'assistant') break;
                if (chatMessages[j].role === 'user') {
                  previousUserMsg = chatMessages[j];
                  break;
                }
              }
            }
            return (
              <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', margin: '12px 0', clear: 'both' }}>
                <div style={{
                  fontSize: '11px',
                  color: 'var(--vscode-descriptionForeground, #a0a0a0)',
                  background: 'var(--vscode-badge-background, rgba(255, 255, 255, 0.06))',
                  border: '1px solid var(--vscode-border, rgba(255, 255, 255, 0.12))',
                  borderRadius: '12px',
                  padding: '4px 14px',
                  maxWidth: '85%',
                  wordBreak: 'break-word',
                  textAlign: 'center',
                  lineHeight: '1.4'
                }}>
                  {msg.content}
                </div>
                {previousUserMsg && !isAgentRunning && (
                  <button
                    type="button"
                    onClick={() => runChatAction(() => onGenerateResponseForUserMessage?.(chatMessages.indexOf(previousUserMsg), previousUserMsg))}
                    style={{
                      padding: '7px 11px',
                      background: 'var(--vscode-button-background, #0e639c)',
                      color: 'var(--vscode-button-foreground, #ffffff)',
                      border: '1px solid rgba(255,255,255,0.12)',
                      borderRadius: '4px',
                      cursor: 'pointer',
                      fontSize: '12px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '7px',
                      width: 'fit-content',
                      boxShadow: '0 1px 0 rgba(255,255,255,0.08) inset',
                    }}
                    title={t('chatPanel.tryAgain', 'Tentar Novamente')}
                  >
                    <RefreshCw size={14} />
                    {t('chatPanel.tryAgain', 'Tentar Novamente')}
                  </button>
                )}
              </div>
            );
          }

          const isUser = msg.role === 'user';
          const isLastUserOrAssistantMessage = !chatMessages.slice(i + 1).some(m => m.role === 'user' || m.role === 'assistant');
          // A user turn without a following assistant turn is resumable.  System
          // messages are deliberately ignored because they are implementation
          // metadata and must not hide the continuation action after reload.
          const canContinueUserMessage = isUser && isLastUserOrAssistantMessage && !isAgentRunning && editingMessageIndex !== i;
          const atts = msg._attachments || [];
          const persistedThoughtStream = !isUser ? String(msg._thoughtStream || '').trim() : '';
          
          const interruptionProbe = contentWithoutThink(msg.content);
          const isInterrupted = !isUser && interruptionProbe && (
            interruptionProbe === '[INTERRUPTED] The user interrupted the agent execution.' ||
            interruptionProbe.startsWith('Interrupted:') ||
            interruptionProbe.startsWith('Interrompido:')
          );
          let displayContent = isUser && isInternalResumePrompt(msg.content)
            ? t('chatPanel.continue', 'Continue')
            : msg.content;
          if (isInterrupted) {
            displayContent = t('app.interruptionNotice');
          }
          if (hideThink && !isUser && displayContent) {
            displayContent = displayContent.replace(/<think>[\s\S]*?(<\/think>|$)/gi, '');
          }

          const isError = !isUser && displayContent && (
            displayContent.includes('🔴') ||
            displayContent.includes('err_connection_failed')
          );


          const legacyErrorProbe = contentWithoutThink(displayContent);
          const shouldShowTryAgain = !isUser && (
            isRetryableAssistantErrorMessage(msg, displayContent) ||
            msg.is_error === true ||
            /^\s*(🔴|ðŸ”´|\u{1F534})\s*(Agent Error|Erro do Agente|Erro:|Error:|Falha|Failure|Failed|Falha na execução)/i.test(legacyErrorProbe) ||
            /Erro do Agente|Agent Error|cota de uso|créditos suficientes|Insufficient AI credits|CRITICAL WORKER CRASH/i.test(legacyErrorProbe)
          );

          let lastUserMsgBeforeThis = null;
          if (shouldShowTryAgain || isInterrupted) {
            for (let j = i - 1; j >= 0; j--) {
              if (chatMessages[j].role === 'user') {
                lastUserMsgBeforeThis = chatMessages[j];
                break;
              }
            }
          }

          return (
            <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span
                    className={`vscode-chat-msg-header ${isUser ? 'chat-header-user' : 'chat-header-agent'}`}
                    style={{ margin: 0 }}
                  >
                    {isUser ? t('chatPanel.you') : t('chatPanel.opalatex')}
                  </span>
                  {msg.timestamp && (
                    <span style={{ fontSize: '10px', color: 'var(--vscode-descriptionForeground, #717171)' }}>
                      {new Date(msg.timestamp).toLocaleString()}
                    </span>
                  )}
                </div>
                {isUser && (
                  <button
                    onClick={() => handleStartEditMessage(i, msg)}
                    disabled={isAgentRunning}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      cursor: isAgentRunning ? 'not-allowed' : 'pointer',
                      color: 'var(--vscode-descriptionForeground, #717171)',
                      display: 'flex',
                      alignItems: 'center',
                      padding: '2px',
                      borderRadius: '3px',
                      transition: 'background-color 0.1s, color 0.1s',
                      opacity: isAgentRunning ? 0.5 : 1,
                    }}
                    title={t('chatPanel.editMessage', 'Edit message')}
                    className="msg-action-btn"
                  >
                    <Pencil size={12} />
                  </button>
                )}
                <button
                  onClick={() => handleBranchChat(i, msg)}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    color: 'var(--vscode-descriptionForeground, #717171)',
                    display: 'flex',
                    alignItems: 'center',
                    padding: '2px',
                    borderRadius: '3px',
                    transition: 'background-color 0.1s, color 0.1s',
                  }}
                  title={t('chatPanel.branchMessage', 'Criar branch a partir daqui')}
                  className="msg-action-btn"
                >
                  <GitBranch size={12} />
                </button>
                {!isUser && (
                  <button
                    onClick={() => handleExportSingleMessage(msg.content)}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                      color: 'var(--vscode-descriptionForeground, #717171)',
                      display: 'flex',
                      alignItems: 'center',
                      padding: '2px',
                      borderRadius: '3px',
                      transition: 'background-color 0.1s, color 0.1s',
                    }}
                    title={t('chatPanel.exportMessage', 'Exportar esta resposta')}
                    className="msg-action-btn"
                  >
                    <Download size={12} />
                  </button>
                )}
              </div>
              {/* Attachment previews */}
              {atts.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', margin: '2px 0' }}>
                  {atts.map((att, ai) => (
                    <div key={ai} style={{
                      display: 'flex', alignItems: 'center', gap: '4px',
                      background: '#2d2d2d', borderRadius: '4px', padding: '3px 7px',
                      fontSize: '11px', color: '#aaa',
                    }}>
                      {att._previewUrl
                        ? <img src={att._previewUrl} alt={att.name} style={{ height: '40px', borderRadius: '3px', objectFit: 'cover' }} />
                        : <FileText size={14} style={{ color: '#4ec9b0' }} />}
                      <span>{att.name}</span>
                    </div>
                  ))}
                </div>
              )}
              <div className="vscode-chat-msg-content">
                {persistedThoughtStream && !hideThink && (
                  <details style={{ margin: '0 0 8px 0', border: '1px solid var(--vscode-widget-border, #3c3c3c)', borderRadius: '4px', background: 'var(--titlebar-bg, #252526)' }}>
                    <summary style={{ padding: '6px 10px', fontSize: '11px', cursor: 'pointer', userSelect: 'none', color: 'var(--vscode-descriptionForeground, #717171)' }}>
                      {t('chatPanel.aiThoughts', 'Pensamentos da IA')}
                    </summary>
                    <pre style={{ margin: 0, padding: '10px', background: 'var(--editor-bg, #1e1e1e)', overflowX: 'auto', fontSize: '11px', color: 'var(--vscode-textPreformat-foreground, #d7ba7d)', borderTop: '1px solid var(--vscode-widget-border, #3c3c3c)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                      {persistedThoughtStream}
                    </pre>
                  </details>
                )}
                {editingMessageIndex === i && isUser ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <textarea
                      value={editingMessageDraft}
                      onChange={(e) => setEditingMessageDraft(e.target.value)}
                      className="vscode-chat-textarea"
                      rows={Math.min(8, Math.max(2, editingMessageDraft.split('\n').length))}
                      autoFocus
                      disabled={isAgentRunning}
                      style={{
                        width: '100%',
                        resize: 'vertical',
                        minHeight: '72px',
                        boxSizing: 'border-box',
                      }}
                    />
                    <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end' }}>
                      <button
                        type="button"
                        onClick={() => handleSubmitEditMessage(i, msg)}
                        disabled={isAgentRunning || !editingMessageDraft.trim()}
                        className="vscode-button"
                        title={t('chatPanel.saveEdit', 'Save edit')}
                        style={{ padding: '5px 7px', display: 'flex', alignItems: 'center' }}
                      >
                        <Check size={13} />
                      </button>
                      <button
                        type="button"
                        onClick={handleCancelEditMessage}
                        className="vscode-button"
                        title={t('chatPanel.cancelEdit', 'Cancel edit')}
                        style={{
                          padding: '5px 7px',
                          display: 'flex',
                          alignItems: 'center',
                          background: 'transparent',
                          border: '1px solid var(--vscode-border)',
                          color: 'var(--vscode-text-fg)',
                        }}
                      >
                        <X size={13} />
                      </button>
                    </div>
                  </div>
                ) : (
                  formatMessageContent(displayContent, activeProject?.project_path)
                )}
                {shouldShowTryAgain && isLastUserOrAssistantMessage && !isAgentRunning && lastUserMsgBeforeThis && (
                  <button
                    type="button"
                    onClick={() => runChatAction(() => handleSendMessage(null, lastUserMsgBeforeThis))}
                    style={{
                      marginTop: '8px',
                      padding: '6px 10px',
                      background: 'var(--vscode-button-background, #0e639c)',
                      color: 'var(--vscode-button-foreground, #ffffff)',
                      border: 'none',
                      borderRadius: '3px',
                      cursor: 'pointer',
                      fontSize: '12px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      width: 'fit-content'
                    }}
                  >
                    <RefreshCw size={14} /> {t('chatPanel.tryAgain', 'Tentar Novamente')}
                  </button>
                )}
                {isInterrupted && isLastUserOrAssistantMessage && !isAgentRunning && (
                  <button
                    type="button"
                    onClick={() => runChatAction(() => handleSendMessage(null, null, {
                      resumeInterrupted: true,
                      displayText: t('chatPanel.continue', 'Continuar'),
                    }))}
                    style={{
                      marginTop: '8px',
                      padding: '6px 10px',
                      background: 'var(--vscode-button-background, #0e639c)',
                      color: 'var(--vscode-button-foreground, #ffffff)',
                      border: 'none',
                      borderRadius: '3px',
                      cursor: 'pointer',
                      fontSize: '12px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      width: 'fit-content'
                    }}
                  >
                    <ArrowRight size={14} /> {t('chatPanel.continue', 'Continuar')}
                  </button>
                )}
                {canContinueUserMessage && (
                  <button
                    type="button"
                    onClick={() => runChatAction(() => handleSendMessage(null, null, {
                      resumeInterrupted: true,
                      displayText: t('chatPanel.continue', 'Continue'),
                    }))}
                    style={{
                      marginTop: '10px',
                      padding: '7px 11px',
                      background: 'var(--vscode-button-background, #0e639c)',
                      color: 'var(--vscode-button-foreground, #ffffff)',
                      border: '1px solid rgba(255,255,255,0.12)',
                      borderRadius: '4px',
                      cursor: 'pointer',
                      fontSize: '12px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '7px',
                      width: 'fit-content',
                      boxShadow: '0 1px 0 rgba(255,255,255,0.08) inset',
                    }}
                    title={t('chatPanel.continue', 'Continue')}
                  >
                    <ArrowRight size={14} />
                    {t('chatPanel.continue', 'Continue')}
                  </button>
                )}
              </div>
            </div>
          );
        })}

        {isAgentRunning && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <span className="vscode-chat-msg-header chat-header-agent">{t('chatPanel.opalatex')}</span>
            <div className="vscode-chat-msg-content">
              {(chatThoughtStream && !hideThink) ? (
                <details open style={{ margin: '8px 0', border: '1px solid var(--vscode-widget-border, #3c3c3c)', borderRadius: '4px', background: 'var(--titlebar-bg, #252526)' }}>
                  <summary style={{ padding: '6px 10px', fontSize: '11px', cursor: 'pointer', userSelect: 'none', color: 'var(--vscode-descriptionForeground, #717171)' }}>
                    {t('chatPanel.aiThoughts', 'Pensamentos da IA')}
                  </summary>
                  <pre style={{ margin: 0, padding: '10px', background: 'var(--editor-bg, #1e1e1e)', overflowX: 'auto', fontSize: '11px', color: 'var(--vscode-textPreformat-foreground, #d7ba7d)', borderTop: '1px solid var(--vscode-widget-border, #3c3c3c)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                    {chatThoughtStream}
                  </pre>
                </details>
              ) : chatThoughtStream ? (
                <div className="thinking-indicator">
                  <span className="dot" />
                  <span className="dot" />
                  <span className="dot" />
                </div>
              ) : !chatResponseStream ? (
                <div className="thinking-indicator">
                  <span className="dot" />
                  <span className="dot" />
                  <span className="dot" />
                </div>
              ) : null}
              {chatResponseStream && (
                <pre
                  className="chat-stream-raw"
                  style={{
                    margin: chatThoughtStream && !hideThink ? '8px 0 0' : 0,
                    color: 'var(--chat-text, #cccccc)',
                    fontFamily: 'var(--vscode-editor-font-family, monospace)',
                    fontSize: '13px',
                    lineHeight: '1.5',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}
                >{chatResponseStream}</pre>
              )}
            </div>
          </div>
        )}
        <div ref={chatEndRef} />
      </div>

      {/* Input form */}
      <form
        onSubmit={handleFormSubmit}
        className="vscode-chat-form"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        style={
          isDragOver
            ? { outline: '2px dashed #4ec9b0', outlineOffset: '-2px' }
            : isEvolvingPrompt
            ? {
                border: '1px solid #4ec9b0',
                boxShadow: '0 0 12px rgba(78, 201, 176, 0.4)',
                transition: 'border-color 0.3s ease, box-shadow 0.3s ease',
              }
            : {}
        }
      >
        {/* Evolution Visual Progress Banner */}
        {evolutionProgress && (
          <div
            style={{
              padding: '6px 12px',
              margin: '6px 10px 4px 10px',
              borderRadius: '6px',
              background: 'linear-gradient(135deg, rgba(78, 201, 176, 0.15), rgba(197, 134, 192, 0.15))',
              border: '1px solid rgba(78, 201, 176, 0.4)',
              boxShadow: '0 0 10px rgba(78, 201, 176, 0.2)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              fontSize: '12px',
              color: 'var(--vscode-text-fg)',
              animation: 'opc-fade-in 0.2s ease',
            }}
          >
            <div className="flex items-center" style={{ gap: '8px' }}>
              {evolutionProgress.complete ? (
                <Check size={14} style={{ color: '#4ec9b0' }} />
              ) : (
                <Sparkles size={14} className="spin" style={{ color: '#4ec9b0' }} />
              )}
              <span style={{ fontWeight: 500 }}>
                {evolutionProgress.complete
                  ? t('chatPanel.evolvedSuccess')
                  : t('chatPanel.evolvingIteration', {
                      iteration: evolutionProgress.iteration || 1,
                      total: evolutionProgress.total || 1,
                    })}
              </span>
            </div>
            {!evolutionProgress.complete && (
              <div style={{ fontSize: '10px', opacity: 0.85, background: 'rgba(0,0,0,0.25)', padding: '2px 6px', borderRadius: '4px', border: '1px solid rgba(78, 201, 176, 0.3)' }}>
                {Math.round((((evolutionProgress.iteration || 1) - 1) / (evolutionProgress.total || 1)) * 100)}%
              </div>
            )}
          </div>
        )}
        {/* Pending attachment preview strip */}
        {pendingAttachments && pendingAttachments.length > 0 && (
          <div style={{
            display: 'flex', flexWrap: 'wrap', gap: '6px',
            padding: '6px 10px', borderBottom: '1px solid #2d2d2d',
          }}>
            {pendingAttachments.map((att, idx) => (
              <div key={idx} style={{
                display: 'flex', alignItems: 'center', gap: '4px',
                background: '#2a2a2a', border: '1px solid #3d3d3d',
                borderRadius: '4px', padding: '3px 6px', fontSize: '11px', color: '#ccc',
              }}>
                {att._previewUrl
                  ? <img src={att._previewUrl} alt={att.name} style={{ height: '32px', borderRadius: '2px', objectFit: 'cover' }} />
                  : <FileText size={13} style={{ color: '#4ec9b0' }} />}
                <span style={{ maxWidth: '100px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{att.name}</span>
                <button
                  type="button"
                  onClick={() => removeAttachment(idx)}
                  style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#888', padding: '0 2px', lineHeight: 1 }}
                >
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        )}
        {/* Upload status */}
        {uploadingFiles && (
          <div style={{ padding: '4px 10px', fontSize: '11px', color: '#888' }}>
            {t('chatPanel.uploadingFiles', 'Processing attachment...')}
          </div>
        )}
        <div className="vscode-chat-input-row">
          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,application/pdf,.docx,.pptx,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.presentationml.presentation"
            multiple
            style={{ display: 'none' }}
            onChange={handleFileInputChange}
            id="chat-file-input"
          />
          {/* Paperclip button */}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={!activeProject || isAgentRunning}
            title={t('chatPanel.attachFile', 'Attach image, PDF, DOCX, or PPTX')}
            style={{
              background: 'transparent', border: 'none', cursor: 'pointer',
              color: (pendingAttachments && pendingAttachments.length > 0) ? '#4ec9b0' : '#666',
              padding: '4px', display: 'flex', alignItems: 'center',
            }}
          >
            <Paperclip size={15} />
          </button>
          <textarea
            ref={inputRef}
            rows={1}
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={!activeProject || isAgentRunning || isEvolvingPrompt}
            placeholder={
              !activeProject ? t('chatPanel.setProjectFirst') :
              isAgentRunning ? t('chatPanel.thinking') :
              isEvolvingPrompt ? t('chatPanel.evolving', 'Evolving...') :
              t('chatPanel.askOpalaTex')
            }
            className="vscode-chat-textarea"
          />
          {/* Evolve Prompt Button */}
          <button
            type="button"
            onClick={handleEvolvePrompt}
            disabled={!activeProject || !chatInput.trim() || isAgentRunning || isEvolvingPrompt}
            title={isEvolvingPrompt ? t('chatPanel.evolving', 'Evolving...') : t('chatPanel.evolvePrompt', 'Evolve prompt')}
            className="vscode-button"
            style={{
              padding: '6px',
              backgroundColor: 'transparent',
              border: 'none',
              color: isEvolvingPrompt ? '#4ec9b0' : 'var(--vscode-text-fg, #cccccc)',
              cursor: (!activeProject || !chatInput.trim() || isAgentRunning || isEvolvingPrompt) ? 'not-allowed' : 'pointer',
              opacity: (!activeProject || !chatInput.trim() || isAgentRunning || isEvolvingPrompt) ? 0.4 : 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {isEvolvingPrompt ? (
              <RefreshCw size={14} className="spin" />
            ) : (
              <Sparkles size={14} style={{ color: (!activeProject || !chatInput.trim() || isAgentRunning) ? 'inherit' : '#4ec9b0' }} />
            )}
          </button>
          {isAgentRunning ? (
            <button
              type="button"
              onClick={handleInterruptAgent}
              className="vscode-button"
              disabled={isInterruptPending}
              style={{ padding: '6px', backgroundColor: '#f48771', color: '#1e1e1e', opacity: isInterruptPending ? 0.7 : 1 }}
              title={t('chatPanel.interruptAgent')}
            >
              {isInterruptPending ? <RefreshCw size={14} className="spin" /> : <X size={14} />}
            </button>
          ) : (
            <button
              type="submit"
              disabled={!activeProject || (!chatInput.trim() && (!pendingAttachments || pendingAttachments.length === 0))}
              className="vscode-button"
              style={{ padding: '6px' }}
            >
              <ArrowRight size={14} />
            </button>
          )}
        </div>
      </form>
    </aside>
  );
}
