import React, { useState, useEffect, useRef, useTransition } from 'react';
import '@xterm/xterm/css/xterm.css';
import { useTranslation } from 'react-i18next';
import i18n from './i18n/index.js';

// Utils
import { safeGetLocalStorage, safeSetLocalStorage } from './utils/storage';

// Hooks
import { useResizing } from './hooks/useResizing';

// Layout components
import ActivityBar from './components/ActivityBar';
import StatusBar from './components/StatusBar';
import ExplorerSidebar from './components/ExplorerSidebar';
import GitSidebar from './components/GitSidebar';
import EditorPanel from './components/EditorPanel';
import ChatPanel from './components/ChatPanel';
import ChatSidebar from './components/ChatSidebar';
import BottomPanel from './components/BottomPanel';
import ContextMenu from './components/ContextMenu';

// Modals
import InstallDepsPrompt from './components/modals/InstallDepsPrompt';
import NewProjectModal from './components/modals/NewProjectModal';
import EditProjectModal from './components/modals/EditProjectModal';
import SettingsModal from './components/modals/SettingsModal';
import ConfirmModal from './components/modals/ConfirmModal';
import AlertModal from './components/modals/AlertModal';
import InteractiveTerminalModal from './components/modals/InteractiveTerminalModal';
import AskModal from './components/modals/AskModal';
import HardwareModal from './components/modals/HardwareModal';
import OnboardingModal from './components/modals/OnboardingModal';
import DirPickerModal from './components/modals/DirPickerModal';
import DeleteProjectModal from './components/modals/DeleteProjectModal';

import EditModelsModal from './components/modals/EditModelsModal';
import AddProviderModal from './components/modals/AddProviderModal';
import LicenseModal from './components/modals/LicenseModal';

const CLOUD_MODEL_IDS = new Set(['OpalaTexCloud', 'OpalaTexCloudGemini35Flash']);
const normalizeCloudModelId = (model, fallback = 'OpalaTexCloud') => CLOUD_MODEL_IDS.has(model) ? model : (CLOUD_MODEL_IDS.has(fallback) ? fallback : 'OpalaTexCloud');

const normalizeEditorPathKey = (filePath, caseInsensitive = false) => {
  if (!filePath) return '';
  let normalized = String(filePath)
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\.\//, '');
  const parts = [];
  for (const part of normalized.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..' && parts.length > 0 && parts[parts.length - 1] !== '..') {
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  normalized = parts.join('/');
  return caseInsensitive ? normalized.toLowerCase() : normalized;
};

const normalizeInlineReplacementSpacing = (replacementText, originalText = '', eol = '\n') => {
  const toLf = (value) => String(value || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const replacement = toLf(replacementText);
  const original = toLf(originalText);
  const replacementLines = replacement.split('\n');
  const originalLines = original.split('\n');
  const isBlank = (line) => line.trim() === '';
  const replacementNonBlank = replacementLines.filter(line => !isBlank(line));
  const originalNonBlank = originalLines.filter(line => !isBlank(line));

  if (
    originalNonBlank.length > 0 &&
    replacementNonBlank.length === originalNonBlank.length &&
    replacementLines.length > originalLines.length + Math.max(4, Math.ceil(originalLines.length * 0.2))
  ) {
    const gapsFor = (lines) => {
      const gaps = [];
      let pendingBlankCount = 0;
      let seenContent = false;
      let leading = 0;
      const content = [];

      for (const line of lines) {
        if (isBlank(line)) {
          pendingBlankCount += 1;
          continue;
        }
        if (!seenContent) {
          leading = pendingBlankCount;
        } else {
          gaps.push(pendingBlankCount);
        }
        seenContent = true;
        pendingBlankCount = 0;
        content.push(line);
      }

      return { leading, gaps, trailing: pendingBlankCount, content };
    };

    const originalGaps = gapsFor(originalLines);
    const replacementGaps = gapsFor(replacementLines);
    const rebuilt = [];
    const pushBlankLines = (count) => {
      for (let i = 0; i < count; i += 1) rebuilt.push('');
    };

    pushBlankLines(Math.min(replacementGaps.leading, originalGaps.leading));
    replacementGaps.content.forEach((line, index) => {
      if (index > 0) {
        pushBlankLines(Math.min(
          replacementGaps.gaps[index - 1] || 0,
          originalGaps.gaps[index - 1] || 0,
        ));
      }
      rebuilt.push(line);
    });
    pushBlankLines(Math.min(replacementGaps.trailing, originalGaps.trailing));
    return rebuilt.join('\n').replace(/\n/g, eol);
  }

  const originalBlankCount = originalLines.length - originalNonBlank.length;
  const replacementBlankCount = replacementLines.length - replacementNonBlank.length;
  if (
    originalNonBlank.length > 0 &&
    replacementLines.length > originalLines.length + Math.max(4, Math.ceil(originalLines.length * 0.2)) &&
    replacementBlankCount > originalBlankCount + Math.max(4, Math.ceil(originalLines.length * 0.15))
  ) {
    return replacementLines
      .filter((line, index, lines) => {
        if (!isBlank(line)) return true;
        const previous = lines[index - 1];
        const next = lines[index + 1];
        return !(previous && next && !isBlank(previous) && !isBlank(next));
      })
      .join('\n')
      .replace(/\n/g, eol);
  }

  return replacement.replace(/\n/g, eol);
};

const isBinaryEditorFile = (filePath) => {
  if (!filePath) return false;
  return /\.(docx|pptx)$/i.test(String(filePath));
};

// ─────────────────────────────────────────────────────────────────────────────
// App
// ─────────────────────────────────────────────────────────────────────────────
export default function App() {
  const { t } = useTranslation();

  // ── Projects / files ──────────────────────────────────────────────────────
  const [projects, setProjects] = useState([]);
  const [activeProject, setActiveProject] = useState(null);
  const isCaseInsensitiveProjectPath = Boolean(
    activeProject?.project_path?.includes('\\') ||
    /^[a-z]:/i.test(activeProject?.project_path || '') ||
    navigator.userAgent.toLowerCase().includes('windows')
  );
  const filePathKey = (filePath) => normalizeEditorPathKey(filePath, isCaseInsensitiveProjectPath);
  const sameFilePath = (left, right) => filePathKey(left) === filePathKey(right);
  const isFileInsidePath = (filePath, parentPath) => {
    const parentKey = filePathKey(parentPath);
    const childKey = filePathKey(filePath);
    return childKey === parentKey || childKey.startsWith(`${parentKey}/`);
  };
  const replaceFilePathPrefix = (filePath, oldPath, newPath) => {
    if (!isFileInsidePath(filePath, oldPath)) return filePath;
    const normalizedFile = String(filePath).replace(/\\/g, '/');
    const normalizedOld = String(oldPath).replace(/\\/g, '/').replace(/\/+$/g, '');
    const oldSegments = normalizedOld.split('/').filter(Boolean).length;
    const suffix = normalizedFile.split('/').filter(Boolean).slice(oldSegments).join('/');
    return suffix ? `${newPath}/${suffix}` : newPath;
  };
  const dedupeOpenFileList = (files, preferredPath = null) => {
    const preferredKey = preferredPath ? filePathKey(preferredPath) : null;
    const seen = new Set();
    return files.reduce((deduped, file) => {
      const key = filePathKey(file);
      if (!key || seen.has(key)) return deduped;
      seen.add(key);
      deduped.push(preferredKey === key ? preferredPath : file);
      return deduped;
    }, []);
  };
  const [files, setFiles] = useState([]);
  const [selectedFile, setSelectedFile] = useState(null);
  const [selectedNodes, setSelectedNodes] = useState(new Set());
  const [fileContent, setFileContent] = useState('');
  const [openFiles, setOpenFiles] = useState([]);
  const [fileContents, setFileContents] = useState({});
  const [originalFileContents, setOriginalFileContents] = useState({});
  const [rightClickedNode, setRightClickedNode] = useState(null);
  const [isSaving, setIsSaving] = useState(false);

  // ── Chat / agent ──────────────────────────────────────────────────────────
  const [chatMessages, setChatMessages] = useState([]);
  const [chatThoughtStream, setChatThoughtStream] = useState('');
  const chatThoughtStreamRef = useRef('');
  const agentResumeEventsRef = useRef([]);
  const [chatInput, setChatInput] = useState('');
  const [pendingAttachments, setPendingAttachments] = useState([]);
  const [isAgentRunning, setIsAgentRunning] = useState(false);
  const [isInlineRunning, setIsInlineRunning] = useState(false);

  // ── Bottom panel ──────────────────────────────────────────────────────────
  const [terminalLogs, setTerminalLogs] = useState([]);
  const [problems, setProblems] = useState([]);
  const [achievementsMemory, setAchievementsMemory] = useState('');
  const [isTerminalCollapsed, setIsTerminalCollapsed] = useState(true);
  const [activeBottomTab, setActiveBottomTab] = useState('thinking');
  const [panelMaxLines, setPanelMaxLines] = useState(() => {
    const stored = safeGetLocalStorage('panelMaxLines');
    const parsed = stored !== null ? Number(stored) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1000;
  });

  // ── UI state ──────────────────────────────────────────────────────────────
  const [layoutMode, setLayoutMode] = useState('ide');
  const [isChatVisible, setIsChatVisible] = useState(false);
  const [activeSidebarTab, setActiveSidebarTab] = useState('explorer');
  const [contextMenu, setContextMenu] = useState(null);
  const [clipboardNode, setClipboardNode] = useState(null);
  const [jumpToLine, setJumpToLine] = useState(null);
  const [showAdvancedParams, setShowAdvancedParams] = useState(false);
  const [dirPicker, setDirPicker] = useState(null);
  const [alertMessage, setAlertMessage] = useState('');

  useEffect(() => {
    const nativeAlert = window.alert;
    window.alert = (message) => setAlertMessage(String(message ?? ''));
    return () => { window.alert = nativeAlert; };
  }, []);


  useEffect(() => {
    if (layoutMode === 'chat') {
      setIsChatVisible(true);
    }
  }, [layoutMode]);

  // ── Git ───────────────────────────────────────────────────────────────────
  const [gitChanges, setGitChanges] = useState([]);
  const [commitMessage, setCommitMessage] = useState('');
  const [isCommitting, setIsCommitting] = useState(false);
  const [useShadowGit, setUseShadowGit] = useState(false);
  const currentGitRootPath = activeProject?.git_root_path || '';
  const gitQuerySuffix = () => {
    if (!activeProject) return '';
    const params = new URLSearchParams({
      projectPath: activeProject.project_path,
      shadow: String(useShadowGit),
    });
    if (!useShadowGit && currentGitRootPath) params.set('gitRootPath', currentGitRootPath);
    return params.toString();
  };
  const gitRequestPayload = (extra = {}) => ({
    projectPath: activeProject?.project_path,
    shadow: useShadowGit,
    ...(!useShadowGit && currentGitRootPath ? { gitRootPath: currentGitRootPath } : {}),
    ...extra,
  });

  // ── Drag-and-drop ─────────────────────────────────────────────────────────
  const [draggedNode, setDraggedNode] = useState(null);
  const [dragOverPath, setDragOverPath] = useState(null);

  // ── Panel sizing ──────────────────────────────────────────────────────────
  const [sidebarWidth, setSidebarWidth] = useState(330);
  const [chatWidth, setChatWidth] = useState(400);
  const [bottomPanelHeight, setBottomPanelHeight] = useState(240);
  const [isEditorMaximized, setIsEditorMaximized] = useState(false);
  const [isBottomMaximized, setIsBottomMaximized] = useState(false);

  // ── Modals ─────────────────────────────────────────────────────────────────
  const [showNewProjectModal, setShowNewProjectModal] = useState(false);
  const [importError, setImportError] = useState('');
  const [newProjName, setNewProjName] = useState('');
  const [newProjPath, setNewProjPath] = useState('');
  const [newProjDesc, setNewProjDesc] = useState('');
  const [newProjModel, setNewProjModel] = useState('ollama/gemma4:12b');
  const [newProjWorkerModel, setNewProjWorkerModel] = useState('');
  const [newProjMode, setNewProjMode] = useState('auto');
  const [newProjModelParams, setNewProjModelParams] = useState({});
  const [newProjWorkerModelParams, setNewProjWorkerModelParams] = useState({});
  const [newProjApiKey, setNewProjApiKey] = useState('');
  const [newProjApiBase, setNewProjApiBase] = useState('http://localhost:11434/v1');
  const [newProjWorkerApiKey, setNewProjWorkerApiKey] = useState('');
  const [newProjWorkerApiBase, setNewProjWorkerApiBase] = useState('');
  const [newProjError, setNewProjError] = useState('');

  const [editingProject, setEditingProject] = useState(null);
  const [editProjError, setEditProjError] = useState('');
  const [projectToDelete, setProjectToDelete] = useState(null);
  const [confirmRequest, setConfirmRequest] = useState(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isHardwareModalOpen, setIsHardwareModalOpen] = useState(false);
  const [webSearchConfig, setWebSearchConfig] = useState({ enabled: true, mcp_url: '', mcp_tool: 'web_search' });
  const [showInstallPrompt, setShowInstallPrompt] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);

  // ── Licensing ─────────────────────────────────────────────────────────────
  const [licenseData, setLicenseData] = useState(null);
  const [showLicenseModal, setShowLicenseModal] = useState(false);

  // ── Global Models ─────────────────────────────────────────────────────────
  const [globalModels, setGlobalModels] = useState([]);
  const [showEditModelsModal, setShowEditModelsModal] = useState(false);
  const [showAddProviderModal, setShowAddProviderModal] = useState(false);
  const [editingModelModalData, setEditingModelModalData] = useState(null);

  // ── IDE settings ──────────────────────────────────────────────────────────
  const [settingsTab, setSettingsTab] = useState('preferences');
  const [activeChatId, setActiveChatId] = useState('main');
  const [chats, setChats] = useState([]);
  const [theme, setTheme] = useState(() => safeGetLocalStorage('theme', 'dark'));
  const [editorFontSize, setEditorFontSize] = useState(() => Number(safeGetLocalStorage('editorFontSize', 13)));
  const [editorTabSize, setEditorTabSize] = useState(() => Number(safeGetLocalStorage('editorTabSize', 4)));
  const [editorWordWrap, setEditorWordWrap] = useState(() => safeGetLocalStorage('editorWordWrap', 'on'));
  const [globalAiProvider, setGlobalAiProvider] = useState('local');
  const [globalCloudModel, setGlobalCloudModel] = useState('OpalaTexCloud');

  useEffect(() => {
    fetch('/api/settings/ai-provider')
      .then(r => r.ok ? r.json() : null)
      .then(cfg => {
        if (cfg?.provider) setGlobalAiProvider(cfg.provider);
        if (cfg?.cloud_model) setGlobalCloudModel(normalizeCloudModelId(cfg.cloud_model));
      })
      .catch(() => { });
  }, []);

  const [isPending, startTransition] = useTransition();
  const [isLoadingChat, setIsLoadingChat] = useState(false);

  // ── Optional dependencies ─────────────────────────────────────────────────
  const [isInstallingDeps, setIsInstallingDeps] = useState(false);
  const [installDepsStatus, setInstallDepsStatus] = useState('');
  const [installDepsLog, setInstallDepsLog] = useState('');

  // ── Ephemeral Agent Params ────────────────────────────────────────────────
  const [ephemeralParams, setEphemeralParams] = useState(() => {
    try { return JSON.parse(localStorage.getItem('ephemeralParams')) || {}; } catch { return {}; }
  });

  const [triggerCompileRequest, setTriggerCompileRequest] = useState(null);

  // ── Inline prompt (editor Ctrl+L / context-menu actions) ────────────────
  const [inlinePrompt, setInlinePrompt] = useState(null);
  // Stores the Monaco range that should be replaced after an inline agent reply
  const pendingInlineRangeRef = useRef(null);
  const pendingWritePathRef = useRef(null);

  // ── Refs ──────────────────────────────────────────────────────────────────
  const terminalRef = useRef(null);
  const terminalInstanceRef = useRef(null);
  const fitAddonRef = useRef(null);
  const eventSourceRef = useRef(null);
  const chatEndRef = useRef(null);
  const logEndRef = useRef(null);
  const editorRef = useRef(null);
  const monacoRef = useRef(null);
  const saveFileRef = useRef(null);
  const binarySaveHandlerRef = useRef(null);
  const diskFileContentsRef = useRef({});
  const importFileInputRef = useRef(null);
  const importTargetPathRef = useRef('');

  async function refreshSelectedFileFromDiskIfUnmodified() {
    if (!activeProject?.project_path || !selectedFile) return;
    if (isBinaryEditorFile(selectedFile)) return;
    const lastDiskContent = diskFileContentsRef.current[selectedFile];
    if (lastDiskContent === undefined || fileContent !== lastDiskContent) return;
    try {
      const res = await fetch(`/api/file/read?projectPath=${encodeURIComponent(activeProject.project_path)}&filePath=${encodeURIComponent(selectedFile)}&t=${Date.now()}`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.content === lastDiskContent) return;
      diskFileContentsRef.current[selectedFile] = data.content;
      setFileContent(data.content);
      setFileContents(prev => ({ ...prev, [selectedFile]: data.content }));
      setOriginalFileContents(prev => ({ ...prev, [selectedFile]: data.content }));
      addLog('info', t('app.reloadedFromDisk', { path: selectedFile }));
    } catch {
      // Ignore transient file reads; the next refresh/focus will try again.
    }
  }

  // ── Hooks ─────────────────────────────────────────────────────────────────
  const { startResizing } = useResizing({ setSidebarWidth, setChatWidth, setBottomPanelHeight, sidebarWidth, chatWidth, bottomPanelHeight });

  // ── Effects ───────────────────────────────────────────────────────────────
  useEffect(() => {
    // Registration identifies the Cloud account but never locks the local app.
    fetch('/api/license/status')
      .then(res => res.json())
      .then(licData => {
        setLicenseData(licData);
      })
      .catch(console.error);

    fetch('/api/onboarding/status')
      .then(res => res.json())
      .then(data => {
        if (!data.completed) {
          setShowOnboarding(true);
        } else {
          fetchProjects();
        }
      })
      .catch(() => {
        // Fallback if endpoint fails
        fetchProjects();
      });
  }, []);

  const handleOnboardingComplete = () => {
    setShowOnboarding(false);
    fetchProjects();
    fetch('/api/settings/ai-provider')
      .then(r => r.ok ? r.json() : null)
      .then(cfg => {
        if (cfg?.provider) setGlobalAiProvider(cfg.provider);
        if (cfg?.cloud_model) setGlobalCloudModel(normalizeCloudModelId(cfg.cloud_model));
      })
      .catch(() => { });
  };

  const fetchGlobalModels = () => {
    fetch('/api/settings/models')
      .then(res => res.json())
      .then(data => {
        if (data.models) setGlobalModels(data.models);
      })
      .catch(console.error);
  };

  useEffect(() => {
    fetchGlobalModels();
  }, []);

  const handleGlobalModelSave = async (modelData) => {
    try {
      const previousModelId = modelData.previous_id || modelData.id;
      const res = await fetch('/api/settings/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(modelData)
      });
      if (res.ok) {
        const projectUsesMainModel = activeProject?.model === previousModelId || activeProject?.model === modelData.id;
        const projectUsesWorkerModel = activeProject?.worker_model === previousModelId || activeProject?.worker_model === modelData.id;
        if (activeProject && (projectUsesMainModel || projectUsesWorkerModel)) {
          const payload = {
            project_name: activeProject.name,
            chat_id: activeChatId
          };
          if (projectUsesMainModel) {
            payload.model = modelData.id;
            payload.api_key = modelData.api_key || '';
            payload.api_base = modelData.api_base || '';
          }
          if (projectUsesWorkerModel) {
            payload.worker_model = modelData.id;
            payload.worker_api_key = modelData.api_key || '';
            payload.worker_api_base = modelData.api_base || '';
          }

          const projectRes = await fetch('/api/opalatex/update-project', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          if (projectRes.ok) {
            const updated = await projectRes.json();
            setActiveProject(prev => prev ? ({ ...prev, ...updated }) : prev);
            setProjects(prev => prev.map(p => (p.name === updated.name) ? { ...p, ...updated } : p));
            setEditingProject(prev => {
              if (!prev || prev.name !== updated.name) return prev;
              return { ...prev, ...updated };
            });
          }
        }
        fetchGlobalModels();
        setShowAddProviderModal(false);
      }
    } catch (e) { console.error(e); }
  };

  const handleGlobalModelDelete = async (modelId) => {
    try {
      const res = await fetch('/api/settings/models', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: modelId })
      });
      if (res.ok) fetchGlobalModels();
    } catch (e) { console.error(e); }
  };

  const handleProjectModelChange = async (field, value) => {
    if (!activeProject) return;
    try {
      const selectedModelObj = globalModels.find(m => m.id === value);
      const payload = {
        project_name: activeProject.name,
        display_name: activeProject.project_name || activeProject.name,
        project_path: activeProject.project_path,
        main_file: activeProject.main_file || '',
        model: activeProject.model,
        worker_model: activeProject.worker_model,
        mode: activeProject.mode,
        description: activeProject.description,
        model_params: activeProject.model_params,
        worker_model_params: activeProject.worker_model_params,
        api_key: activeProject.api_key,
        api_base: activeProject.api_base,
        worker_api_key: activeProject.worker_api_key,
        worker_api_base: activeProject.worker_api_base,
        use_shared_memory: activeProject.use_shared_memory,
        chat_id: activeChatId
      };

      // Update specific field (orchestrator or worker)
      if (field === 'model') {
        payload.model = value;
        if (selectedModelObj) {
          payload.api_key = selectedModelObj.api_key;
          payload.api_base = selectedModelObj.api_base;
        }
      } else if (field === 'worker_model') {
        payload.worker_model = value;
        if (selectedModelObj) {
          payload.worker_api_key = selectedModelObj.api_key;
          payload.worker_api_base = selectedModelObj.api_base;
        }
      }

      const res = await fetch('/api/opalatex/update-project', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        const updated = await res.json();
        setActiveProject(prev => ({ ...prev, ...updated }));
        setProjects(prev => prev.map(p => (p.name === updated.name) ? { ...p, ...updated } : p));
      }
    } catch (err) {
      console.error('Failed to update project model', err);
    }
  };

  useEffect(() => {
    fetch('/api/settings/web-search')
      .then(r => r.ok ? r.json() : null)
      .then(cfg => { if (cfg) setWebSearchConfig(cfg); })
      .catch(() => { });
  }, []);

  // Restore language from backend on startup (localStorage not reliable in webview)
  useEffect(() => {
    fetch('/api/settings/language')
      .then(r => r.ok ? r.json() : null)
      .then(cfg => {
        if (cfg?.lang) {
          i18n.changeLanguage(cfg.lang);
        } else {
          // No saved preference — push current detected language to backend
          const detected = i18n.language?.startsWith('pt') ? 'pt' : 'en';
          fetch('/api/settings/language', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lang: detected }),
          }).catch(() => { });
        }
      })
      .catch(() => { });
  }, []);

  useEffect(() => {
    if (!editingProject) setShowAdvancedParams(false);
  }, [editingProject]);

  useEffect(() => {
    if (!showNewProjectModal) setNewProjError('');
  }, [showNewProjectModal]);

  // Track the name of the last project for which chat was initialised, so that
  // re-rendering the same project (e.g. after saving its settings) does NOT wipe
  // the chat history. Messages are only reset when switching to a DIFFERENT project.
  const prevProjectNameRef = useRef(null);

  useEffect(() => {
    if (activeProject) {
      fetchFiles();
      fetchProblems();
      if (prevProjectNameRef.current !== activeProject.name) {
        prevProjectNameRef.current = activeProject.name;

        // Show a blank state while we load — avoid flash of stale greeting
        setChatMessages([]);
        setIsLoadingChat(true);

        // Fetch chats
        fetch(`/api/chat/list?project_name=${encodeURIComponent(activeProject.name)}&t=${Date.now()}`)
          .then(res => res.json())
          .then(data => {
            const loadedChats = data.chats || [];
            setChats(loadedChats);

            // Set active chat id: use the one stored in the project or fall back to the first chat
            const currentChatId = activeProject.current_chat_id
              || (loadedChats.length > 0 ? loadedChats[0].id : 'main');
            setActiveChatId(currentChatId);
            if (!activeProject.current_chat_id) {
              setActiveProject(prev => prev ? { ...prev, current_chat_id: currentChatId } : null);
            }

            // Now fetch history for this chat
            fetch(`/api/chat/history?project_name=${encodeURIComponent(activeProject.name)}&chat_id=${encodeURIComponent(currentChatId)}&t=${Date.now()}`)
              .then(res => res.json())
              .then(histData => {
                startTransition(() => {
                  if (histData.history && histData.history.length > 0) {
                    // Restore previous conversation
                    setChatMessages(histData.history);
                  } else {
                    // First time opening this project/chat → show greeting
                    const greeting = activeProject.project_name || activeProject.name;
                    setChatMessages([{ role: 'assistant', content: t('app.greeting', { projectName: greeting }) }]);
                  }
                });
              })
              .catch(err => {
                console.error("Failed to fetch chat history:", err);
                const greeting = activeProject.project_name || activeProject.name;
                startTransition(() => {
                  setChatMessages([{ role: 'assistant', content: t('app.greeting', { projectName: greeting }) }]);
                });
              })
              .finally(() => {
                setIsLoadingChat(false);
              });
          })
          .catch(err => {
            console.error("Failed to fetch chat list:", err);
            const greeting = activeProject.project_name || activeProject.name;
            startTransition(() => {
              setChatMessages([{ role: 'assistant', content: t('app.greeting', { projectName: greeting }) }]);
            });
            setIsLoadingChat(false);
          });

        setOpenFiles([]);
        setSelectedFile(null);
        setFileContent('');
        setFileContents({});
        setOriginalFileContents({});
        setGitChanges([]);
        setTerminalLogs([]);
        setAchievementsMemory('');
        setCommitMessage('');
      }
    } else {
      setFiles([]);
      setSelectedFile(null);
      setFileContent('');
      setOpenFiles([]);
      setFileContents({});
      setOriginalFileContents({});
      setProblems([]);
      setChats([]);
      setChatMessages([]);
      setActiveChatId('main');
      setGitChanges([]);
      setTerminalLogs([]);
      setAchievementsMemory('');
      setCommitMessage('');
      prevProjectNameRef.current = null;
    }
  }, [activeProject]);

  const handleSwitchChat = async (id) => {
    if (!activeProject || id === activeChatId) return;
    setIsLoadingChat(true);
    setActiveChatId(id);
    setActiveProject(prev => prev ? { ...prev, current_chat_id: id } : null);

    setTimeout(async () => {
      try {
        const res = await fetch(`/api/chat/history?project_name=${encodeURIComponent(activeProject.name)}&chat_id=${encodeURIComponent(id)}&t=${Date.now()}`);
        if (res.ok) {
          const data = await res.json();
          const greeting = activeProject.project_name || activeProject.name;
          startTransition(() => {
            if (data.history && data.history.length > 0) {
              setChatMessages(data.history);
            } else {
              setChatMessages([{ role: 'assistant', content: t('app.greeting', { projectName: greeting }) }]);
            }
          });
        }
      } catch (err) {
        console.error(err);
      } finally {
        setIsLoadingChat(false);
      }
    }, 10);
  };

  useEffect(() => {
    if (!activeProject || !selectedFile) return;
    if (isBinaryEditorFile(selectedFile)) {
      setOriginalFileContents(prev => ({ ...prev, [selectedFile]: '' }));
      return;
    }
    fetch(`/api/git/file-at-head?${gitQuerySuffix()}&filePath=${encodeURIComponent(selectedFile)}&t=${Date.now()}`)
      .then(r => r.ok ? r.json() : null)
      .then(gitData => {
        if (gitData && gitData.content !== undefined) {
          setOriginalFileContents(prev => ({ ...prev, [selectedFile]: gitData.content }));
        } else {
          setOriginalFileContents(prev => ({ ...prev, [selectedFile]: '' }));
        }
      })
      .catch(() => {
        setOriginalFileContents(prev => ({ ...prev, [selectedFile]: '' }));
      });
  }, [useShadowGit, currentGitRootPath, selectedFile, activeProject]);

  useEffect(() => {
    const disableContextMenu = (e) => e.preventDefault();
    const closeMenu = () => setContextMenu(null);
    document.addEventListener('contextmenu', disableContextMenu);
    document.addEventListener('click', closeMenu);
    return () => {
      document.removeEventListener('contextmenu', disableContextMenu);
      document.removeEventListener('click', closeMenu);
    };
  }, []);

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [chatMessages]);

  // Global keyboard shortcuts (Ctrl+S, Ctrl+J, Ctrl+/- zoom)
  useEffect(() => {
    const handleKeyDown = (e) => {
      const isCtrl = e.ctrlKey || e.metaKey;
      if (isCtrl && e.key === 's') { e.preventDefault(); saveFile(); }
      else if (isCtrl && e.key === 'j') {
        e.preventDefault();
        if (isBottomMaximized) {
          setIsBottomMaximized(false);
        } else if (isTerminalCollapsed) {
          setIsTerminalCollapsed(false);
        } else {
          setIsTerminalCollapsed(true);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedFile, fileContent, activeProject, isBottomMaximized, isTerminalCollapsed]);

  useEffect(() => {
    safeSetLocalStorage('theme', theme);
    if (theme === 'light') document.body.classList.add('light-theme');
    else document.body.classList.remove('light-theme');
  }, [theme]);

  useEffect(() => {
    if (activeProject) fetchGitStatus();
    else setGitChanges([]);
  }, [activeProject]);

  useEffect(() => {
    diskFileContentsRef.current = {};
  }, [activeProject?.project_path]);

  useEffect(() => {
    if (!activeProject) return;
    const refreshWorkspace = () => {
      fetchFiles();
      fetchGitStatus();
      refreshSelectedFileFromDiskIfUnmodified();
    };
    const interval = setInterval(refreshWorkspace, 10000);
    window.addEventListener('focus', refreshWorkspace);
    document.addEventListener('visibilitychange', refreshWorkspace);
    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', refreshWorkspace);
      document.removeEventListener('visibilitychange', refreshWorkspace);
    };
  }, [activeProject, useShadowGit, currentGitRootPath, selectedFile, fileContent]);

  useEffect(() => {
    if (activeSidebarTab === 'git' && activeProject) fetchGitStatus();
  }, [activeSidebarTab, activeProject, currentGitRootPath]);

  // Un-maximize editor if all files are closed
  useEffect(() => {
    if (openFiles.length === 0 && isEditorMaximized) {
      setIsEditorMaximized(false);
    }
  }, [openFiles, isEditorMaximized]);

  useEffect(() => {
    setOpenFiles(prev => {
      const deduped = dedupeOpenFileList(prev, selectedFile);
      return deduped.length === prev.length && deduped.every((file, index) => file === prev[index])
        ? prev
        : deduped;
    });
  }, [isCaseInsensitiveProjectPath, selectedFile]);

  // ── Helpers ───────────────────────────────────────────────────────────────
  const trimToLimit = (arr, limit) => arr.length > limit ? arr.slice(arr.length - limit) : arr;

  const contentHasPersistedThought = (content) => {
    const text = String(content || '');
    return /<think>[\s\S]*?<\/think>/i.test(text)
      || /```(?:thought|reasoning)[\s\S]*?```/i.test(text);
  };

  const withPersistedThought = (content, thoughtSnapshot) => {
    const text = String(content || '');
    const thought = String(thoughtSnapshot || '').trim();
    if (!thought || contentHasPersistedThought(text)) return text;
    return `<think>\n${thought}\n</think>\n\n${text}`.trim();
  };

  const compactTextForAgent = (value, limit = 2400) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
    if (text.length <= limit) return text;
    return `${text.slice(0, limit)}\n[truncated ${text.length - limit} chars]`;
  };

  const compactAgentEventForResume = (eventObj) => {
    const { event, ...data } = eventObj || {};
    if (!event || !['thought', 'reflection', 'stream_chunk', 'tool_call', 'tool_result', 'problem', 'error', 'info'].includes(event)) {
      return null;
    }
    if (event === 'tool_call') {
      return {
        event,
        agent: data.agent || '',
        tool: data.tool || '',
        arguments: compactTextForAgent(data.arguments || {}, 1200),
      };
    }
    if (event === 'tool_result') {
      return {
        event,
        agent: data.agent || '',
        tool: data.tool || '',
        is_error: Boolean(data.is_error),
        result: compactTextForAgent(data.result || data.content || '', 1600),
      };
    }
    return {
      event,
      agent: data.agent || '',
      content: compactTextForAgent(data.content || data.message || '', 1600),
    };
  };

  const rememberAgentEventForResume = (eventObj) => {
    const compact = compactAgentEventForResume(eventObj);
    if (!compact) return;
    agentResumeEventsRef.current = trimToLimit([...agentResumeEventsRef.current, compact], 80);
  };

  const collectRecentChatAttachments = (messages, limit = 3) => {
    const seen = new Set();
    const collected = [];
    for (let i = (messages || []).length - 1; i >= 0; i--) {
      const atts = messages[i]?._attachments || [];
      for (let j = atts.length - 1; j >= 0; j--) {
        const att = atts[j];
        const key = `${att.type || ''}:${att.name || ''}:${att.mime || ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        collected.push(att);
        if (collected.length >= limit) return collected.reverse();
      }
    }
    return collected.reverse();
  };

  const serializeChatHistoryForAgent = (messages, limit = 18) => (
    (messages || [])
      .slice(-limit)
      .filter(msg => msg && (msg.role === 'user' || msg.role === 'assistant' || msg.role === 'system'))
      .map(msg => ({
        role: msg.role,
        content: compactTextForAgent(msg.content || '', 4000),
      }))
  );

  const buildResumePrompt = (messages, events) => {
    const recentMessages = serializeChatHistoryForAgent(messages, 12)
      .map((msg, index) => `${index + 1}. ${msg.role.toUpperCase()}:\n${msg.content}`)
      .join('\n\n');
    const recentEvents = (events || [])
      .slice(-30)
      .map((item, index) => `${index + 1}. ${compactTextForAgent(item, 1800)}`)
      .join('\n\n');
    const attachments = collectRecentChatAttachments(messages, 5)
      .map((att, index) => `${index + 1}. ${att.name || 'attachment'} (${att.type || 'unknown'}${att.mime ? `, ${att.mime}` : ''})`)
      .join('\n');

    return [
      'Continue the task that was interrupted. Do not restart from scratch.',
      'Use the chat history, captured thoughts, tool activity, and referenced artifacts below as the current working context.',
      'Prefer continuing the latest unfinished user request. If an action already appears completed in the context, do not repeat it unless verification is needed.',
      '',
      '## Recent chat history',
      recentMessages || '(no recent chat history captured)',
      '',
      '## Captured agent activity before interruption',
      recentEvents || '(no agent activity captured)',
      '',
      '## Recent referenced attachments',
      attachments || '(no recent attachments captured)',
    ].join('\n');
  };

  const addLog = (type, message, agent) =>
    setTerminalLogs(prev => {
      let next;
      if (prev.length > 0) {
        const last = prev[prev.length - 1];
        if (last.type === type && last.agent === agent && (type === 'thought' || type === 'reflection' || type === 'stream_chunk' || type === 'stdout' || type === 'stderr')) {
          next = [...prev.slice(0, -1), { ...last, message: last.message + message }];
        }
      }
      if (!next) next = [...prev, { type, message, agent, timestamp: new Date().toLocaleTimeString() }];
      return trimToLimit(next, panelMaxLines);
    });

  const addProblem = ({ tool = t('app.agentTool', 'Agent'), message, severity = 'error' }) => {
    if (!message) return;
    setProblems(prev => trimToLimit([
      ...prev,
      {
        id: Math.random().toString(),
        tool,
        message,
        severity,
        timestamp: new Date().toLocaleTimeString(),
      },
    ], panelMaxLines));
  };

  // ── API calls ─────────────────────────────────────────────────────────────
  const fetchProjects = async () => {
    try {
      const res = await fetch('/api/opalatex/list-projects');
      if (res.ok) {
        const data = await res.json();
        setProjects(data.projects || []);
        if (data.projects?.length > 0 && !activeProject) {
          const firstValid = data.projects.find(p => p.exists);
          if (firstValid) handleSelectProject(firstValid);
        }
      }
    } catch (err) { addLog('error', t('app.failedToLoadProjects', { error: err.message })); }
  };

  const fetchFiles = async () => {
    if (!activeProject) return;
    try {
      const res = await fetch(`/api/files?projectPath=${encodeURIComponent(activeProject.project_path)}`);
      if (res.ok) { const data = await res.json(); setFiles(data.files || []); }
      else { const e = await res.json(); addLog('error', t('app.failedToListFiles', { error: e.error })); }
    } catch (err) { addLog('error', t('app.fileCallError', { error: err.message })); }
  };

  const fetchProblems = async () => {
    if (!activeProject) return;
    try {
      const res = await fetch(`/api/opalatex/problems?projectPath=${encodeURIComponent(activeProject.project_path)}`);
      if (res.ok) {
        const data = await res.json();
        setProblems(prev => {
          const nonLinter = prev.filter(p => p.tool !== 'python-linter');
          return trimToLimit([...nonLinter, ...(data.problems || [])], panelMaxLines);
        });
      }
    } catch (err) { console.error('Failed to fetch problems', err); }
  };

  const fetchGitStatus = async () => {
    if (!activeProject) return;
    try {
      const res = await fetch(`/api/git/status?${gitQuerySuffix()}&t=${Date.now()}`);
      if (res.ok) {
        const data = await res.json();
        // console.log(`[DEBUG fetchGitStatus] projectPath="${activeProject.project_path}" shadow=${useShadowGit} files=`, data.files);
        setGitChanges(data.files || []);
      }
    } catch (err) { console.error('Failed to fetch git status', err); }
  };

  const handleSelectProject = (proj) => {
    if (proj.exists === false) {
      addLog('error', t('app.projectDirMissing', { path: proj.project_path }));
      return;
    }

    let currentContents = { ...fileContents };
    if (selectedFile) {
      currentContents[selectedFile] = fileContent;
    }

    const dirtyFiles = openFiles.filter(f => currentContents[f] !== originalFileContents[f] && originalFileContents[f] !== undefined);

    if (dirtyFiles.length > 0) {
      setConfirmRequest({
        prompt: `Você tem ${dirtyFiles.length} arquivo(s) não salvo(s) no projeto atual. Deseja salvá-los antes de trocar de projeto? (Escolha "Cancelar" para não trocar)`,
        options: ['yes', 'no', 'cancel'],
        callback: async (val) => {
          if (val === 'cancel') return;
          if (val === 'yes') {
            for (const filePath of dirtyFiles) {
              try {
                await fetch('/api/file/write', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ projectPath: activeProject.project_path, filePath, content: currentContents[filePath] })
                });
              } catch (e) { }
            }
          }
          setActiveProject(proj);
          addLog('info', t('app.projectSelected', { name: proj.project_name || proj.name }));
        }
      });
      return;
    }

    setActiveProject(proj);
    addLog('info', t('app.projectSelected', { name: proj.project_name || proj.name }));
  };

  const handleGitCommit = async (e) => {
    if (e) e.preventDefault();
    if (!activeProject || !commitMessage.trim() || isCommitting) return;
    setIsCommitting(true);
    addLog('info', t('app.commitCreating', { message: commitMessage }));
    try {
      const res = await fetch('/api/git/commit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(gitRequestPayload({ message: commitMessage })),
      });
      const data = await res.json();
      if (res.ok) { addLog('info', t('app.commitSuccess')); setCommitMessage(''); fetchGitStatus(); }
      else { addLog('error', t('app.commitFailed', { error: data.error || t('app.unknownError') })); }
    } catch (err) { addLog('error', t('app.commitError', { error: err.message })); }
    finally { setIsCommitting(false); }
  };

  const handleStageFile = async (filePath) => {
    if (!activeProject) return false;
    try {
      const res = await fetch('/api/git/stage', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(gitRequestPayload({ filePath, action: 'stage' })),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || t('app.unknownError'));
      }
      fetchGitStatus();
      return true;
    } catch (err) {
      addLog('error', t('app.stageError', { error: err.message }));
      return false;
    }
  };

  const handleUnstageFile = async (filePath) => {
    if (!activeProject) return false;
    try {
      const res = await fetch('/api/git/stage', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(gitRequestPayload({ filePath, action: 'unstage' })),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || t('app.unknownError'));
      }
      fetchGitStatus();
      return true;
    } catch (err) {
      addLog('error', t('app.unstageError', { error: err.message }));
      return false;
    }
  };

  const handleDiscardFile = async (filePath) => {
    if (!activeProject) return;
    try {
      const res = await fetch('/api/git/discard', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(gitRequestPayload({ filePath })),
      });
      if (res.ok) {
        addLog('info', t('app.changesDiscarded', { path: filePath }));
        setFileContents(prev => {
          const next = { ...prev };
          delete next[filePath];
          return next;
        });
        if (sameFilePath(selectedFile, filePath)) {
          const readRes = await fetch(`/api/file/read?projectPath=${encodeURIComponent(activeProject.project_path)}&filePath=${encodeURIComponent(filePath)}&t=${Date.now()}`);
          if (readRes.ok) {
            const data = await readRes.json();
            diskFileContentsRef.current[filePath] = data.content;
            setFileContent(data.content);
            setFileContents(prev => ({ ...prev, [filePath]: data.content }));
            setOriginalFileContents(prev => ({ ...prev, [filePath]: data.content }));
          } else {
            delete diskFileContentsRef.current[filePath];
            setOpenFiles(prev => prev.filter(f => !sameFilePath(f, filePath)));
            setSelectedFile(null);
            setFileContent('');
            setOriginalFileContents(prev => {
              const next = { ...prev };
              delete next[filePath];
              return next;
            });
          }
        }
        fetchGitStatus();
        fetchFiles();
        return;
      }
      if (res.ok) { addLog('info', t('app.changesDiscarded', { path: filePath })); fetchGitStatus(); fetchFiles(); }
      else { const d = await res.json(); addLog('error', t('app.discardFailed', { error: d.error })); }
    } catch (err) { addLog('error', t('app.discardChangesError', { error: err.message })); }
  };

  const handleCheckpointRestored = async (commit) => {
    diskFileContentsRef.current = {};
    setOpenFiles([]);
    setSelectedFile(null);
    setSelectedNodes(new Set());
    setFileContent('');
    setFileContents({});
    setOriginalFileContents({});
    setJumpToLine(null);
    await fetchFiles();
    await fetchGitStatus();
    addLog('info', t('app.checkpointRestored', { short: commit.short }));
  };

  const handleInstallOptionalDeps = async () => {
    if (isInstallingDeps) return;
    setIsInstallingDeps(true);
    setInstallDepsStatus('Instalando...');
    setInstallDepsLog('Iniciando pip install...\n');
    try {
      const response = await fetch('/api/settings/install-dependencies', { method: 'POST' });
      if (!response.ok) throw new Error(t('app.installStartFailed'));
      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const data = JSON.parse(line.trim());
            if (data.output) setInstallDepsLog(prev => prev + data.output);
            if (data.status === 'success') setInstallDepsStatus('Instalado com Sucesso!');
            else if (data.status === 'error') setInstallDepsStatus('Erro na Instalação');
          } catch (e) { /* ignore chunk parsing errors */ }
        }
      }
    } catch (err) {
      setInstallDepsStatus('Falha ao conectar');
      setInstallDepsLog(prev => prev + `\nErro: ${err.message}\n`);
    } finally { setIsInstallingDeps(false); }
  };

  // ── File operations ────────────────────────────────────────────────────────
  const handleNodeSelect = (nodePath, isDirectory, e) => {
    if (e.ctrlKey || e.metaKey) {
      setSelectedNodes(prev => {
        const next = new Set(prev);
        if (next.has(nodePath)) next.delete(nodePath);
        else next.add(nodePath);
        return next;
      });
      return;
    }

    // Normal click clears multi-selection
    setSelectedNodes(new Set());
    if (!isDirectory) {
      handleFileSelect(nodePath);
    }
  };

  const handleFileSelect = async (filePath, jumpLine = null) => {
    if (!activeProject) return;
    setIsBottomMaximized(false);
    if (selectedFile) setFileContents(prev => ({ ...prev, [selectedFile]: fileContent }));
    if (isBinaryEditorFile(filePath)) {
      setOpenFiles(prev => {
        const deduped = dedupeOpenFileList(prev, filePath);
        return deduped.some(openFile => sameFilePath(openFile, filePath))
          ? deduped.map(openFile => sameFilePath(openFile, filePath) ? filePath : openFile)
          : [...deduped, filePath];
      });
      setFileContent('');
      setSelectedFile(filePath);
      setLayoutMode('ide');
      return;
    }
    const cachedFilePath = Object.keys(fileContents).find(path => sameFilePath(path, filePath)) || filePath;
    setOpenFiles(prev => {
      const deduped = dedupeOpenFileList(prev, filePath);
      return deduped.some(openFile => sameFilePath(openFile, filePath))
        ? deduped.map(openFile => sameFilePath(openFile, filePath) ? filePath : openFile)
        : [...deduped, filePath];
    });
    if (cachedFilePath !== filePath) {
      setFileContents(prev => ({ ...prev, [filePath]: prev[cachedFilePath] }));
      setOriginalFileContents(prev => (
        prev[cachedFilePath] === undefined ? prev : { ...prev, [filePath]: prev[cachedFilePath] }
      ));
    }
    if (fileContents[cachedFilePath] !== undefined) {
      setFileContent(fileContents[cachedFilePath]);
      setSelectedFile(filePath);
      setLayoutMode('ide'); // Force the IDE view so the text editor is visible
      if (jumpLine !== null) {
        setJumpToLine({ file: filePath, line: jumpLine });
      }
      return;
    }
    try {
      const res = await fetch(`/api/file/read?projectPath=${encodeURIComponent(activeProject.project_path)}&filePath=${encodeURIComponent(filePath)}`);
      if (res.ok) {
        const data = await res.json();
        diskFileContentsRef.current[filePath] = data.content;
        setFileContent(data.content);
        setFileContents(prev => ({ ...prev, [filePath]: data.content }));
        setOriginalFileContents(prev => ({ ...prev, [filePath]: data.content }));
        setSelectedFile(filePath);
        setLayoutMode('ide'); // Force the IDE view so the text editor is visible
        if (jumpLine !== null) {
          setJumpToLine({ file: filePath, line: jumpLine });
        }

        fetch(`/api/git/file-at-head?${gitQuerySuffix()}&filePath=${encodeURIComponent(filePath)}&t=${Date.now()}`)
          .then(r => r.ok ? r.json() : null)
          .then(gitData => {
            if (gitData && gitData.content !== undefined) {
              setOriginalFileContents(prev => ({ ...prev, [filePath]: gitData.content }));
            } else {
              setOriginalFileContents(prev => ({ ...prev, [filePath]: '' }));
            }
          })
          .catch(() => {
            setOriginalFileContents(prev => ({ ...prev, [filePath]: '' }));
          });
      }
      else {
        addLog('error', t('app.fileReadFailed', { path: filePath }));
        setSelectedFile(filePath);
        setFileContent('');
        setLayoutMode('ide');
      }
    } catch (err) {
      addLog('error', t('app.readError', { error: err.message }));
      setSelectedFile(filePath);
      setFileContent('');
      setLayoutMode('ide');
    }
  };

  const saveFile = async ({ suppressCompile = false } = {}) => {
    if (!activeProject || !selectedFile) return false;
    if (isBinaryEditorFile(selectedFile)) {
      const saved = await binarySaveHandlerRef.current?.();
      if (saved) return true;
      addLog('error', t('app.fileSaveFailedPath', { path: selectedFile }));
      return false;
    }
    setIsSaving(true);
    try {
      const res = await fetch('/api/file/write', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath: activeProject.project_path, filePath: selectedFile, content: fileContent }),
      });
      if (res.ok) {
        addLog('info', t('app.fileSaved', { path: selectedFile }));
        diskFileContentsRef.current[selectedFile] = fileContent;
        setFileContents(prev => ({ ...prev, [selectedFile]: fileContent }));

        fetch(`/api/git/file-at-head?${gitQuerySuffix()}&filePath=${encodeURIComponent(selectedFile)}&t=${Date.now()}`)
          .then(r => r.ok ? r.json() : null)
          .then(gitData => {
            if (gitData && gitData.content !== undefined) {
              setOriginalFileContents(prev => ({ ...prev, [selectedFile]: gitData.content }));
            } else {
              setOriginalFileContents(prev => ({ ...prev, [selectedFile]: '' }));
            }
          })
          .catch(() => {
            // Do not overwrite originalFileContents on error or 404 if it's unwanted, but actually we should set to empty if untracked.
            setOriginalFileContents(prev => ({ ...prev, [selectedFile]: '' }));
          });
        fetchGitStatus();
        fetchProblems();
        if (!suppressCompile && selectedFile && selectedFile.toLowerCase().match(/\.(tex|cls|sty|bib)$/)) {
          const compileFull = activeProject.compile_on_save_full === true;
          const compilePartial = activeProject.compile_on_save_partial !== false;
          if (compileFull || compilePartial) {
            setTriggerCompileRequest({
              id: Date.now(),
              partial: !compileFull && compilePartial,
            });
          }
        }
        return true;
      }
      else {
        addLog('error', t('app.fileSaveFailedPath', { path: selectedFile }));
        return false;
      }
    } catch (err) {
      addLog('error', t('app.writeError', { error: err.message }));
      return false;
    }
    finally { setIsSaving(false); }
  };

  useEffect(() => { saveFileRef.current = saveFile; }, [saveFile]);

  const handleCloseTab = (filePath, e) => {
    if (e) { e.stopPropagation(); e.preventDefault(); }
    if (sameFilePath(selectedFile, filePath)) setFileContents(prev => ({ ...prev, [filePath]: fileContent }));
    setOpenFiles(prev => {
      const remaining = prev.filter(f => !sameFilePath(f, filePath));
      if (sameFilePath(selectedFile, filePath)) {
        if (remaining.length > 0) {
          const next = remaining[remaining.length - 1];
          setSelectedFile(next);
          setFileContent(isBinaryEditorFile(next) ? '' : (fileContents[next] || ''));
        }
        else { setSelectedFile(null); setFileContent(''); }
      }
      return remaining;
    });
  };

  const handleCreateNewFile = (parentPath) => {
    if (!activeProject) return;
    setConfirmRequest({
      type: 'ask',
      rows: 1,
      prompt: t('app.newFilePrompt'),
      default: parentPath ? `${parentPath}/` : '',
      callback: async (filename) => {
        if (!filename) return;
        try {
          const res = await fetch('/api/file/write', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectPath: activeProject.project_path, filePath: filename, content: '' }) });
          if (res.ok) { addLog('info', t('app.fileCreated', { path: filename })); await fetchFiles(); await handleFileSelect(filename); }
          else { const e = await res.json(); addLog('error', t('app.fileCreateError', { error: e.error })); }
        } catch (err) { addLog('error', t('app.fileCreateCallError', { error: err.message })); }
      }
    });
  };

  const handleCreateNewDir = (parentPath) => {
    if (!activeProject) return;
    setConfirmRequest({
      type: 'ask',
      rows: 1,
      prompt: t('app.newDirPrompt'),
      default: parentPath ? `${parentPath}/` : '',
      callback: async (dirname) => {
        if (!dirname) return;
        try {
          const res = await fetch('/api/file/mkdir', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectPath: activeProject.project_path, dirPath: dirname }) });
          if (res.ok) { addLog('info', t('app.dirCreated', { path: dirname })); await fetchFiles(); }
          else { const e = await res.json(); addLog('error', t('app.dirCreateError', { error: e.error })); }
        } catch (err) { addLog('error', t('app.dirCreateCallError', { error: err.message })); }
      }
    });
  };

  const handleImportFile = (parentPath = '') => {
    if (!activeProject) return;
    importTargetPathRef.current = parentPath || '';
    setContextMenu(null);
    importFileInputRef.current?.click();
  };

  const handleImportFileSelected = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !activeProject) return;

    const targetDir = importTargetPathRef.current || '';
    const formData = new FormData();
    formData.append('projectPath', activeProject.project_path);
    formData.append('targetDir', targetDir);
    formData.append('file', file, file.name);

    try {
      const res = await fetch('/api/file/import', {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('app.importFailed'));
      addLog('info', t('app.fileImported', { path: data.filePath || file.name }));
      await fetchFiles();
      if (data.filePath) await handleFileSelect(data.filePath);
    } catch (err) {
      addLog('error', t('app.importFileError', { error: err.message }));
    }
  };

  const handleRenameNode = (node) => {
    if (!activeProject || !node) return;
    setConfirmRequest({
      type: 'ask',
      rows: 1,
      prompt: t('app.renamePrompt', { path: node.path }),
      default: node.path,
      callback: async (newPath) => {
        if (!newPath || newPath === node.path) return;
        try {
          const res = await fetch('/api/file/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectPath: activeProject.project_path, oldPath: node.path, newPath }) });
          if (res.ok) {
            addLog('info', t('app.itemRenamed', { itemType: t(node.isDirectory ? 'app.itemTypeDirectory' : 'app.itemTypeFile'), oldPath: node.path, newPath }));
            if (!node.isDirectory) {
              setOpenFiles(prev => dedupeOpenFileList(prev.map(f => sameFilePath(f, node.path) ? newPath : f), newPath));
              setFileContents(prev => {
                const n = { ...prev };
                const oldKey = Object.keys(n).find(k => sameFilePath(k, node.path));
                if (oldKey !== undefined) { n[newPath] = n[oldKey]; delete n[oldKey]; }
                return n;
              });
              setOriginalFileContents(prev => {
                const n = { ...prev };
                const oldKey = Object.keys(n).find(k => sameFilePath(k, node.path));
                if (oldKey !== undefined) { n[newPath] = n[oldKey]; delete n[oldKey]; }
                return n;
              });
              if (sameFilePath(selectedFile, node.path)) setSelectedFile(newPath);
            } else {
              setOpenFiles(prev => dedupeOpenFileList(prev.map(f => replaceFilePathPrefix(f, node.path, newPath)), newPath));
              setFileContents(prev => { const n = {}; for (const [k, v] of Object.entries(prev)) n[replaceFilePathPrefix(k, node.path, newPath)] = v; return n; });
              setOriginalFileContents(prev => { const n = {}; for (const [k, v] of Object.entries(prev)) n[replaceFilePathPrefix(k, node.path, newPath)] = v; return n; });
              if (isFileInsidePath(selectedFile, node.path)) setSelectedFile(prev => replaceFilePathPrefix(prev, node.path, newPath));
            }
            await fetchFiles();
          } else { const e = await res.json(); addLog('error', t('app.fileRenameError', { error: e.error })); }
        } catch (err) { addLog('error', t('app.renameError', { error: err.message })); }
      }
    });
  };

  const handleSetMainFile = async (node) => {
    if (!activeProject || !node || node.isDirectory) return;
    try {
      // Calculate relative path from project root
      let relPath = node.path;
      if (activeProject.project_path && node.path.startsWith(activeProject.project_path)) {
        relPath = node.path.substring(activeProject.project_path.length);
        if (relPath.startsWith('/') || relPath.startsWith('\\')) {
          relPath = relPath.substring(1);
        }
      }

      const payload = {
        project_name: activeProject.name,
        main_file: relPath,
        chat_id: activeChatId
      };
      const res = await fetch('/api/opalatex/update-project', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        const updated = await res.json();
        setActiveProject(prev => ({ ...prev, ...updated }));
        setProjects(prev => prev.map(p => (p.name === updated.name) ? { ...p, ...updated } : p));
        addLog('info', t('app.mainFileSet', { path: relPath }));
      } else {
        const err = await res.json();
        addLog('error', t('app.mainFileSetFailed', { error: err.error }));
      }
    } catch (err) {
      addLog('error', t('app.mainFileSetError', { error: err.message }));
    }
  };

  const handleDeleteNode = async (node) => {
    if (!activeProject || !node) return;

    // Se o nó clicado faz parte da seleção múltipla, apagamos todos da seleção
    const nodesToDelete = (selectedNodes && selectedNodes.has(node.path))
      ? Array.from(selectedNodes)
      : [node.path];

    const isMulti = nodesToDelete.length > 1;
    let msg = '';
    if (isMulti) {
      msg = t('app.deleteMultiPrompt', 'Are you sure you want to delete {{count}} selected items? All internal files in directories will also be removed!', { count: nodesToDelete.length });
    } else {
      if (node.isDirectory) {
        msg = t('app.deleteSingleDir', 'Are you sure you want to delete the directory "{{name}}"? All internal files will also be removed!', { name: node.path });
      } else {
        msg = t('app.deleteSingleFile', 'Are you sure you want to delete the file "{{name}}"?', { name: node.path });
      }
    }

    setConfirmRequest({
      prompt: msg,
      options: ['yes', 'no'],
      default: 'no',
      callback: async (value) => {
        if (value !== 'yes') return;
        try {
          let successCount = 0;
          for (const pathToDelete of nodesToDelete) {
            const res = await fetch('/api/file/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectPath: activeProject.project_path, filePath: pathToDelete }) });
            if (res.ok) {
              successCount++;
              setOpenFiles(prev => prev.filter(f => !isFileInsidePath(f, pathToDelete)));
              setFileContents(prev => { const n = {}; for (const [k, v] of Object.entries(prev)) if (!isFileInsidePath(k, pathToDelete)) n[k] = v; return n; });
              setOriginalFileContents(prev => { const n = {}; for (const [k, v] of Object.entries(prev)) if (!isFileInsidePath(k, pathToDelete)) n[k] = v; return n; });
              if (isFileInsidePath(selectedFile, pathToDelete)) {
                // If it's the current file, we can't reliably pick the 'last' open file easily in a loop, so we just clear it.
                setSelectedFile(null); setFileContent('');
              }
            } else {
              const e = await res.json(); addLog('error', t('app.deletePathFailed', { path: pathToDelete, error: e.error }));
            }
          }
          if (successCount > 0) {
            addLog('info', t('app.itemsDeleted', { count: successCount }));
            setSelectedNodes(new Set()); // clear multi-selection
            await fetchFiles();
          }
        } catch (err) { addLog('error', t('app.deleteError', { error: err.message })); }
      }
    });
  };

  const handleMoveNode = async (oldPath, targetDirPath, isDirectory) => {
    if (!activeProject) return;
    const nodeName = oldPath.replace(/\\/g, '/').split('/').pop();
    const newPath = targetDirPath ? `${targetDirPath}/${nodeName}` : nodeName;
    if (oldPath === newPath) return;
    if (isDirectory && (newPath === oldPath || newPath.startsWith(`${oldPath}/`))) { addLog('error', t('app.moveDirectoryIntoItself')); return; }
    try {
      const res = await fetch('/api/file/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectPath: activeProject.project_path, oldPath, newPath }) });
      if (res.ok) { addLog('info', t('app.itemMoved', { itemType: t(isDirectory ? 'app.itemTypeDirectory' : 'app.itemTypeFile'), oldPath, newPath })); await fetchFiles(); }
      else { const e = await res.json(); addLog('error', t('app.moveFailed', { error: e.error })); }
    } catch (err) { addLog('error', t('app.moveError', { error: err.message })); }
  };

  // ── Project CRUD ──────────────────────────────────────────────────────────
  const handleCreateProject = async (e) => {
    e.preventDefault();
    if (!newProjName || !newProjPath) return;
    setNewProjError('');

    const sep = navigator.userAgent.toLowerCase().includes('windows') ? '\\' : '/';
    let basePath = newProjPath;
    if (basePath.endsWith(sep)) basePath = basePath.slice(0, -1);
    const finalProjectPath = `${basePath}${sep}${newProjName}`;

    try {
      const isCloudProvider = globalAiProvider === 'cloud';
      const projectModel = isCloudProvider ? normalizeCloudModelId(newProjModel, globalCloudModel) : newProjModel;
      const projectWorkerModel = isCloudProvider ? normalizeCloudModelId(newProjWorkerModel, globalCloudModel) : newProjWorkerModel;
      const res = await fetch('/api/opalatex/create-project', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_name: newProjName, project_path: finalProjectPath, description: newProjDesc, model: projectModel, worker_model: projectWorkerModel, mode: newProjMode, api_key: isCloudProvider ? '' : newProjApiKey, api_base: isCloudProvider ? '' : newProjApiBase, worker_api_key: isCloudProvider ? '' : newProjWorkerApiKey, worker_api_base: isCloudProvider ? '' : newProjWorkerApiBase, model_params: Object.keys(newProjModelParams).length ? newProjModelParams : undefined, worker_model_params: Object.keys(newProjWorkerModelParams).length ? newProjWorkerModelParams : undefined }),
      });
      if (res.ok) {
        addLog('info', t('app.projectRegistered', { name: newProjName }));
        setShowNewProjectModal(false); setNewProjName(''); setNewProjPath(''); setNewProjDesc(''); setNewProjApiKey(''); setNewProjApiBase('http://localhost:11434/v1'); setNewProjWorkerApiKey(''); setNewProjWorkerApiBase(''); setNewProjModelParams({}); setNewProjWorkerModelParams({});
        fetchProjects();
      } else { const err = await res.json(); setNewProjError(err.error || t('app.projectCreateError')); addLog('error', t('app.projectCreateFailed', { error: err.error })); }
    } catch (err) { setNewProjError(err.message || t('app.projectCreateError')); addLog('error', t('app.projectCreateFailed', { error: err.message })); }
  };

  const handleDeleteProject = (projName) => {
    setProjectToDelete(projName);
  };

  const confirmDeleteProject = async (deleteDir) => {
    if (!projectToDelete) return;
    const projName = projectToDelete;
    setProjectToDelete(null);
    try {
      const res = await fetch('/api/opalatex/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project_name: projName, delete_dir: deleteDir }) });
      if (res.ok) { addLog('info', t('app.projectRemoved', { name: projName })); if (activeProject?.name === projName) setActiveProject(null); fetchProjects(); }
      else { const data = await res.json(); addLog('error', t('app.projectDeleteError', { error: data.error })); }
    } catch (err) { addLog('error', t('app.projectDeleteError', { error: err.message })); }
  };

  const openEditModal = async (e, proj) => {
    e.stopPropagation();
    let fresh = proj;
    try {
      const res = await fetch('/api/opalatex/list-projects');
      if (res.ok) {
        const { projects: list } = await res.json();
        const found = list.find(p => p.name === proj.name);
        if (found) fresh = found;
      }
    } catch (_) { }
    setEditProjError('');
    const compileOnSaveFull = fresh.compile_on_save_full === true;
    const compileOnSavePartial = !compileOnSaveFull && fresh.compile_on_save_partial !== false;
    const selectedMainModel = globalModels.find(m => m.id === fresh.model);
    const selectedWorkerModel = globalModels.find(m => m.id === fresh.worker_model);
    const newState = { name: fresh.name, project_name: fresh.project_name || fresh.name, project_path: fresh.project_path || '', main_file: fresh.main_file || '', git_root_path: fresh.git_root_path || '', compile_on_save_partial: compileOnSavePartial, compile_on_save_full: compileOnSaveFull, model: fresh.model || '', worker_model: fresh.worker_model || '', mode: fresh.mode || 'auto', description: fresh.description || '', model_params: fresh.model_params || {}, worker_model_params: fresh.worker_model_params || {}, api_key: selectedMainModel?.api_key || fresh.api_key || '', api_base: selectedMainModel?.api_base || fresh.api_base || '', worker_api_key: selectedWorkerModel?.api_key || fresh.worker_api_key || '', worker_api_base: selectedWorkerModel?.api_base || fresh.worker_api_base || '', use_shared_memory: fresh.use_shared_memory ?? false };
    setEditingProject(newState);
  };

  const handleUpdateProject = async (e) => {
    e.preventDefault();
    if (!editingProject) return;
    setEditProjError('');

    try {
      const res = await fetch('/api/opalatex/update-project', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_name: editingProject.name, display_name: editingProject.project_name, project_path: editingProject.project_path, main_file: editingProject.main_file, git_root_path: editingProject.git_root_path || '', compile_on_save_partial: editingProject.compile_on_save_partial === true && editingProject.compile_on_save_full !== true, compile_on_save_full: editingProject.compile_on_save_full === true, model: editingProject.model, worker_model: editingProject.worker_model, mode: editingProject.mode, description: editingProject.description, model_params: editingProject.model_params, worker_model_params: editingProject.worker_model_params, api_key: editingProject.api_key, api_base: editingProject.api_base, worker_api_key: editingProject.worker_api_key, worker_api_base: editingProject.worker_api_base, use_shared_memory: editingProject.use_shared_memory, chat_id: activeChatId }),
      });
      if (res.ok) {
        const updated = await res.json();
        addLog('info', t('app.projectUpdated', { name: updated.project_name }));
        setEditingProject(null);
        await fetchProjects();
        if (activeProject?.name === updated.name) setActiveProject(prev => ({ ...prev, ...updated }));
      } else { const err = await res.json(); setEditProjError(err.error || t('app.projectUpdateError')); addLog('error', t('app.projectUpdateFailed', { error: err.error })); }
    } catch (err) { setEditProjError(err.message || t('app.projectUpdateError')); addLog('error', t('app.projectUpdateFailed', { error: err.message })); }
  };

  // ── Dir picker ────────────────────────────────────────────────────────────
  const openDirPicker = async (target, startPath) => {
    const path = startPath || '~';
    try {
      const res = await fetch('/api/fs/dirs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) });
      const data = await res.json();
      setDirPicker({ target, current: data.current, dirs: data.dirs || [] });
    } catch (e) { setDirPicker({ target, current: path, dirs: [] }); }
  };

  const navigateDirPicker = async (path) => {
    try {
      const res = await fetch('/api/fs/dirs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) });
      const data = await res.json();
      setDirPicker(prev => ({ ...prev, current: data.current, dirs: data.dirs || [] }));
    } catch (e) { }
  };

  const updateActiveGitRoot = async (gitRootPath) => {
    if (!activeProject) return;
    try {
      const res = await fetch('/api/opalatex/update-project', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_name: activeProject.name,
          git_root_path: gitRootPath || '',
          chat_id: activeChatId,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setActiveProject(prev => prev ? { ...prev, git_root_path: data.git_root_path || '' } : prev);
        setProjects(prev => prev.map(p => p.name === activeProject.name ? { ...p, git_root_path: data.git_root_path || '' } : p));
        addLog('info', gitRootPath ? t('app.gitRootSet', { path: data.git_root_path }) : t('app.gitRootReset'));
        fetchGitStatus();
      } else {
        addLog('error', t('app.gitRootSetError', { error: data.error || t('app.unknownError') }));
      }
    } catch (err) {
      addLog('error', t('app.gitRootSetError', { error: err.message }));
    }
  };

  const confirmDirPicker = async () => {
    if (!dirPicker) return;
    if (dirPicker.target === 'new') setNewProjPath(dirPicker.current);
    else if (dirPicker.target === 'git-root') {
      await updateActiveGitRoot(dirPicker.current);
    }
    else if (dirPicker.target === 'edit-git-root') {
      setEditingProject(p => ({ ...p, git_root_path: dirPicker.current }));
    }
    else if (dirPicker.target === 'import') {
      // Call import-project API
      try {
        const res = await fetch('/api/opalatex/import-project', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project_path: dirPicker.current })
        });
        const data = await res.json();
        if (res.ok) {
          addLog('info', t('app.projectImported', { name: data.project_name }));
          setImportError('');
          fetchProjects();
        } else {
          setImportError(data.error || t('app.importProjectError'));
          addLog('error', t('app.importProjectErrorDetail', { error: data.error }));
        }
      } catch (err) {
        setImportError(t('app.errorWithMessage', { error: err.message }));
        addLog('error', t('app.importFileError', { error: err.message }));
      }
    }
    else setEditingProject(p => ({ ...p, project_path: dirPicker.current }));
    setDirPicker(null);
  };

  // ── Context menu ──────────────────────────────────────────────────────────
  const handleWorkspaceContextMenu = (e) => {
    if (!activeProject) return;
    e.preventDefault(); e.stopPropagation();
    setRightClickedNode(null);
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  const handleNodeContextMenu = (e, node) => {
    if (!activeProject) return;
    e.preventDefault(); e.stopPropagation();
    setRightClickedNode(node);
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  const handleOpenInSystem = async (node) => {
    setContextMenu(null);
    if (!activeProject || !node) return;
    try {
      await fetch('/api/file/open-explorer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath: activeProject.project_path, filePath: node.path })
      });
    } catch (err) {
      console.error('Failed to open in system:', err);
      addLog('error', t('app.openSystemError', { error: err.message }));
    }
  };

  const handleCopyNode = (node) => {
    setClipboardNode(node);
    setContextMenu(null);
  };

  const handlePasteNode = async (parentPath) => {
    setContextMenu(null);
    if (!clipboardNode || !activeProject) return;
    try {
      const targetName = clipboardNode.name;
      const targetPath = parentPath ? `${parentPath}/${targetName}` : targetName;
      const res = await fetch('/api/file/copy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectPath: activeProject.project_path,
          sourcePath: clipboardNode.path,
          targetPath: targetPath,
        }),
      });
      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || t('app.pasteFailed'));
      }
      fetchFiles();
    } catch (err) {
      addLog('error', t('app.pasteError', { error: err.message }));
    }
  };

  // ── Agent ─────────────────────────────────────────────────────────────────
  const handleInterruptAgent = async () => {
    try {
      const res = await fetch('/api/opalatex/interrupt', { method: 'POST' });
      if (res.ok) {
        addLog('info', t('app.interruptSent'));
        setConfirmRequest(null);
      } else addLog('error', t('app.interruptFailed'));
    } catch (err) { addLog('error', t('app.interruptError', { error: err.message })); }
  };

  const handleAgentEvent = (eventObj) => {
    const { event, ...data } = eventObj;
    rememberAgentEventForResume(eventObj);
    switch (event) {
      case 'server_ready': addLog('info', t('app.agentReady'), data.agent); break;
      case 'agent_started': addLog('info', t('app.agentStarted', { agent: data.agent }), data.agent); break;
      case 'thought':
        addLog('thought', data.content, data.agent);
        setChatThoughtStream(prev => {
          const next = prev + (data.content || '');
          chatThoughtStreamRef.current = next;
          return next;
        });
        break;
      case 'reflection':
        addLog('reflection', data.content, data.agent);
        break;
      case 'achievements_update':
        setAchievementsMemory(data.content);
        break;
      case 'stream_chunk':
        addLog('stream_chunk', data.content, data.agent);
        break;
      case 'cancelled': {
        addLog('warning', data.message || t('app.executionCancelled'), data.agent);
        const thoughtSnapshot = chatThoughtStreamRef.current;
        chatThoughtStreamRef.current = '';
        setChatThoughtStream('');
        const interruptedText = t('app.agentInterrupted', { message: data.message || t('app.agentStopped') });
        const content = withPersistedThought(interruptedText, thoughtSnapshot);
        setChatMessages(prev => [...prev, { role: 'assistant', content, timestamp: new Date().toISOString() }]);
        setConfirmRequest(null);
        break;
      }
      case 'tool_call':
        addLog('tool_call', t('app.callingTool', { tool: data.tool, arguments: JSON.stringify(data.arguments) }), data.agent);
        if (['write_file', 'write_content_pos', 'replace_content_range', 'edit_file'].includes(data.tool)) {
          const writePath = data.arguments?.path;
          if (writePath) pendingWritePathRef.current = writePath;
        }
        break;
      case 'tool_result':
        if (data.is_error) {
          addLog('error', t('app.toolFailed', { tool: data.tool }), data.agent);
        } else {
          addLog('tool_result', t('app.toolSucceeded', { tool: data.tool }), data.agent);
        }
        if (['write_file', 'write_content_pos', 'replace_content_range', 'edit_file'].includes(data.tool)) {
          const writtenPath = pendingWritePathRef.current;
          pendingWritePathRef.current = null;
          if (writtenPath) {
            // Invalidate cached content so the editor reloads from disk on next open.
            // Use the relative path as stored in fileContents (basename only, no leading slash).
            const relPath = writtenPath.replace(/^.*[/\\]/, '') === writtenPath
              ? writtenPath
              : writtenPath.split(/[/\\]/).pop();
            setFileContents(prev => {
              // Remove any key that ends with this relative path segment.
              const updated = { ...prev };
              for (const key of Object.keys(updated)) {
                if (key === writtenPath || key.endsWith('/' + relPath) || key === relPath) {
                  delete updated[key];
                }
              }
              return updated;
            });
            // If this file is currently open in the editor, reload it from disk now.
            if (selectedFile && !isBinaryEditorFile(selectedFile) && (selectedFile === writtenPath || selectedFile.endsWith('/' + relPath) || selectedFile === relPath)) {
              if (activeProject) {
                fetch(`/api/file/read?projectPath=${encodeURIComponent(activeProject.project_path)}&filePath=${encodeURIComponent(selectedFile)}`)
                  .then(r => r.ok ? r.json() : null)
                  .then(d => {
                    if (d) {
                      diskFileContentsRef.current[selectedFile] = d.content;
                      setFileContent(d.content);
                      setFileContents(prev => ({ ...prev, [selectedFile]: d.content }));
                      fetch(`/api/git/file-at-head?${gitQuerySuffix()}&filePath=${encodeURIComponent(selectedFile)}&t=${Date.now()}`)
                        .then(r => r.ok ? r.json() : null)
                        .then(gitData => {
                          if (gitData && gitData.content !== undefined) {
                            setOriginalFileContents(prev => ({ ...prev, [selectedFile]: gitData.content }));
                          } else {
                            setOriginalFileContents(prev => ({ ...prev, [selectedFile]: '' }));
                          }
                        })
                        .catch(() => {
                          setOriginalFileContents(prev => ({ ...prev, [selectedFile]: '' }));
                        });
                    }
                  })
                  .catch(() => { });
              }
            }
          }
        }
        break;
      case 'agent_response':
        addLog('info', t('app.responseReceived'));
        const responseText = (data.response && data.response.trim() !== '')
          ? data.response
          : "⚠️ *O agente concluiu o processamento, mas não emitiu nenhuma resposta textual ou chamada de ferramenta. Isso geralmente acontece quando o modelo de IA sofre uma falha de geração (ex: esqueceu de usar o formato correto após pensar).*";

        // Snapshot thought BEFORE any state calls — React 18 batches updaters async
        const thoughtSnapshot = chatThoughtStreamRef.current;
        chatThoughtStreamRef.current = '';
        setChatThoughtStream('');

        setChatMessages(prev => {
          const last = prev[prev.length - 1];
          const baseContent = data.persisted_response || responseText;
          const finalContent = withPersistedThought(baseContent, thoughtSnapshot);
          if (last?.role === 'assistant' && last.content === finalContent) return prev;
          return [...prev, {
            id: data.message_id,
            role: 'assistant',
            content: finalContent,
            timestamp: new Date().toISOString(),
          }];
        });

        // ── Auto-replace: if there is a pending inline selection range, extract
        //    the first fenced code block from the response and apply it.
        if (pendingInlineRangeRef.current && editorRef.current && monacoRef.current) {
          const range = pendingInlineRangeRef.current;
          pendingInlineRangeRef.current = null;
          try {
            const codeBlockMatch = data.response.match(/```(?:\w+)?\n([\s\S]*?)```/);
            if (codeBlockMatch) {
              const newCode = codeBlockMatch[1].replace(/\n$/, '');
              const monacoRange = new monacoRef.current.Range(
                range.startLineNumber,
                range.startColumn,
                range.endLineNumber,
                range.endColumn,
              );
              const model = editorRef.current.getModel();
              const originalText = model ? model.getValueInRange(monacoRange) : '';
              const normalizedCode = normalizeInlineReplacementSpacing(
                newCode,
                originalText,
                model?.getEOL?.() || '\n',
              );
              editorRef.current.executeEdits('opalatex-inline', [{
                range: monacoRange,
                text: normalizedCode,
                forceMoveMarkers: true,
              }]);
              addLog('info', t('app.inlineReplacementApplied', { start: range.startLineNumber, end: range.endLineNumber }));
            }
          } catch (replaceErr) {
            addLog('error', t('app.inlineReplacementFailed', { error: replaceErr.message }));
          }
        }
        break;
      case 'agent_finished': addLog('info', t('app.processingCompleted', 'Processamento concluído.')); break;
      case 'input_request':
        setConfirmRequest({ ...data, id: data.id, prompt: data.prompt, options: data.options || ['yes', 'no'], default: data.default || 'yes', type: data.type || 'confirm' });
        addLog('info', t('app.waitingConfirmation', '🔔 Aguardando confirmação: {{prompt}}', { prompt: data.prompt }));
        break;
      case 'error':
        addLog('error', data.message);
        addProblem({ tool: data.agent || t('app.agentTool', 'Agent'), message: data.message, severity: 'error' });
        setChatMessages(prev => [...prev, { role: 'assistant', content: t('app.agentError', '🔴 Erro do Agente: {{message}}', { message: data.message }), timestamp: new Date().toISOString() }]);
        break;
      case 'problem':
        addLog('error', t('app.toolProblem', { tool: data.tool, message: data.message }));
        addProblem({ tool: data.tool, message: data.message, severity: data.severity || 'error' });
        break;
      default: addLog('info', t('app.eventReceived', { event }));
    }
  };

  const handleSendMessage = async (e, retryMsg = null, options = {}) => {
    if (e && e.preventDefault) e.preventDefault();
    const targetChatId = options.chatIdOverride || activeChatId;

    try {
      const r = await fetch('/api/settings/ai-provider');
      if (r.ok) {
        const cfg = await r.json();
        if (cfg.provider === 'cloud') {
          const balRes = await fetch('/api/settings/token-balance');
          if (balRes.ok) {
            const balData = await balRes.json();
            if (!balData || balData.balance === undefined || balData.balance <= 0) {
              alert(t('common.noCredits', 'Sem saldo suficiente para usar a cloud. Por favor adicione créditos.'));
              return;
            }
          }
        }
      }
    } catch (_) { }

    let userText = '';
    let displayText = '';
    let attachmentsSnapshot = [];
    let messagesForRequest = undefined;

    if (options.resumeInterrupted) {
      if (!activeProject || isAgentRunning) return;
      const historySnapshot = options.historyOverride || chatMessages;
      userText = buildResumePrompt(historySnapshot, agentResumeEventsRef.current);
      displayText = options.displayText || t('chatPanel.continue', 'Continue');
      attachmentsSnapshot = options.overrideAttachments || collectRecentChatAttachments(historySnapshot, 3);
      messagesForRequest = serializeChatHistoryForAgent(historySnapshot, 18);
    } else if (options.overrideText !== undefined) {
      if (!activeProject || isAgentRunning) return;
      userText = options.overrideText;
      displayText = options.displayText || userText;
      attachmentsSnapshot = options.overrideAttachments || [];
    } else if (retryMsg) {
      if (!activeProject || isAgentRunning) return;
      userText = retryMsg.content === '📎 Attachment' ? '' : retryMsg.content;
      displayText = userText;
      attachmentsSnapshot = retryMsg._attachments || [];
    } else {
      if ((!chatInput.trim() && pendingAttachments.length === 0) || !activeProject || isAgentRunning) return;
      userText = chatInput;
      displayText = userText;
      attachmentsSnapshot = [...pendingAttachments];
      setChatInput('');
      setPendingAttachments([]);
    }
    if (options.replaceFromIndex !== undefined) {
      try {
        const truncateRes = await fetch('/api/chat/truncate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project_name: activeProject.name,
            chat_id: targetChatId,
            from_index: options.replaceFromIndex,
          }),
        });
        if (!truncateRes.ok) {
          const err = await truncateRes.json().catch(() => ({}));
        throw new Error(err.error || t('app.truncateChatFailed'));
        }
      } catch (err) {
        addLog('error', t('app.editPreparationFailed', { error: err.message }));
        return;
      }
    }
    const requestPrompt = userText;
    if (displayText) userText = displayText;
    // Show attachment previews alongside the user message in the chat history
    const userMsg = { role: 'user', content: userText || '📎 Attachment', _attachments: attachmentsSnapshot, timestamp: new Date().toISOString() };
    setChatMessages(prev => {
      if (options.baseMessages) {
        return [...options.baseMessages, userMsg];
      }
      if (options.replaceFromIndex !== undefined) {
        const replaceUiIndex = options.replaceUiIndex ?? options.replaceFromIndex;
        return [...prev.slice(0, replaceUiIndex), userMsg];
      }
      if (retryMsg) {
        const idx = prev.indexOf(retryMsg);
        if (idx !== -1) {
          return [...prev.slice(0, idx), userMsg];
        }
      }
      return [...prev, userMsg];
    });
    setIsAgentRunning(true);
    setProblems([]);
    setAchievementsMemory('');
    chatThoughtStreamRef.current = '';
    setChatThoughtStream('');
    agentResumeEventsRef.current = [];
    addLog('info', t('app.starting', { text: userText }));

    if (userText.trim().startsWith('/')) {
      try {
        const res = await fetch('/api/opalatex/slash-command', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: userText.trim(), project_name: activeProject.name, project_path: activeProject.project_path, chat_id: targetChatId }),
        });
        const result = await res.json();
        if (result.status === 'confirm') {
          setConfirmRequest({ id: result.id, prompt: result.prompt, options: result.options || ['yes', 'no'], default: result.default || 'yes', type: result.type || 'confirm', isSlashCommand: true });
          addLog('info', t('app.waitingConfirmation', { prompt: result.prompt }));
        } else if (result.status === 'done') {
          setChatMessages(prev => [...prev, { role: 'assistant', content: (result.messages || []).join('\n') || 'Comando executado.', timestamp: new Date().toISOString() }]);
        } else {
          setChatMessages(prev => [...prev, { role: 'assistant', content: `🔴 Erro: ${result.error || 'desconhecido'}`, timestamp: new Date().toISOString() }]);
        }
      } catch (err) {
        addLog('error', t('app.commandFailed', { error: err.message }));
        setChatMessages(prev => [...prev, { role: 'assistant', content: `🔴 Falha: ${err.message}`, timestamp: new Date().toISOString() }]);
      } finally { setIsAgentRunning(false); fetchFiles(); }
      return;
    }

    let selectedText = '';
    if (editorRef.current) {
      try { const model = editorRef.current.getModel(); const sel = editorRef.current.getSelection(); if (model && sel) selectedText = model.getValueInRange(sel); } catch (e) { }
    }

    try {
      const res = await fetch('/api/opalatex/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: 'run', agent: 'chat_orchestrator', prompt: requestPrompt,
          project_name: activeProject.name, project_path: activeProject.project_path,
          model: activeProject.model, current_file: selectedFile || '',
          editor_content: fileContent || '', selected_text: selectedText || '',
          lang: i18n.language || 'en',
          chat_id: targetChatId,
          attachments: attachmentsSnapshot,
          messages: messagesForRequest,
        }),
      });
      if (!res.body) { addLog('error', t('app.streamUnsupportedBackend')); setIsAgentRunning(false); return; }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try { handleAgentEvent(JSON.parse(line)); } catch (e) { addLog('stdout', line); }
        }
      }
      if (buffer.trim()) { try { handleAgentEvent(JSON.parse(buffer)); } catch (e) { addLog('stdout', buffer); } }
    } catch (err) {
      addLog('error', t('app.executionFailed', { error: err.message }));
      setChatMessages(prev => [...prev, { role: 'assistant', content: `🔴 Falha na execução: ${err.message}`, timestamp: new Date().toISOString() }]);
    } finally { setIsAgentRunning(false); fetchFiles(); fetchProblems(); }
  };

  const handleEditUserMessage = async (messageIndex, originalMessage, editedContent) => {
    if (!activeProject || isAgentRunning || !originalMessage || originalMessage.role !== 'user') return;
    const nextContent = (editedContent || '').trim();
    if (!nextContent || nextContent === originalMessage.content) return;

    let lastUserIndex = -1;
    for (let i = chatMessages.length - 1; i >= 0; i--) {
      if (chatMessages[i]?.role === 'user') {
        lastUserIndex = i;
        break;
      }
    }

    const attachments = originalMessage._attachments || [];
    const persistedMessageIndex = chatMessages
      .slice(0, messageIndex)
      .filter(msg => msg.id !== undefined || msg.timestamp)
      .length;
    if (messageIndex === lastUserIndex) {
      await handleSendMessage(null, null, {
        overrideText: nextContent,
        overrideAttachments: attachments,
        replaceFromIndex: persistedMessageIndex,
        replaceUiIndex: messageIndex,
      });
      return;
    }

    const sourceChat = chats.find(c => c.id === activeChatId);
    const newChatName = `${sourceChat?.name || 'Chat'} (edited)`;
    try {
      const res = await fetch('/api/chat/branch-edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_name: activeProject.name,
          source_chat_id: activeChatId,
          new_chat_name: newChatName,
          message_index: persistedMessageIndex,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || t('app.editedBranchCreateFailed'));
      }
      const data = await res.json();
      const branchHistory = data.history || [];
      const newChatId = data.new_chat_id;
      setActiveChatId(newChatId);
      setActiveProject(prev => prev ? { ...prev, current_chat_id: newChatId } : null);
      setChats(prev => [...prev, { id: newChatId, name: data.name || newChatName }]);
      setChatMessages(branchHistory);
      await handleSendMessage(null, null, {
        overrideText: nextContent,
        overrideAttachments: attachments,
        chatIdOverride: newChatId,
        baseMessages: branchHistory,
      });
      fetch(`/api/chat/list?project_name=${encodeURIComponent(activeProject.name)}&t=${Date.now()}`)
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (d?.chats) setChats(d.chats); })
        .catch(() => { });
    } catch (err) {
      addLog('error', t('app.editedBranchCreateError', { error: err.message }));
    }
  };

  const handleGenerateResponseForUserMessage = async (messageIndex, message) => {
    if (!activeProject || isAgentRunning || !message || message.role !== 'user') return;
    const content = message.content === '📎 Attachment' ? '' : (message.content || '');
    const attachments = message._attachments || [];
    if (!content.trim() && attachments.length === 0) return;
    const persistedMessageIndex = chatMessages
      .slice(0, messageIndex)
      .filter(msg => msg.id !== undefined || msg.timestamp)
      .length;
    await handleSendMessage(null, null, {
      overrideText: content,
      overrideAttachments: attachments,
      replaceFromIndex: persistedMessageIndex,
      replaceUiIndex: messageIndex,
    });
  };

  const sendConfirmResponse = async (value) => {
    if (!confirmRequest) return;
    const { id, prompt, isSlashCommand, callback } = confirmRequest;
    setConfirmRequest(null);

    if (callback) {
      callback(value);
      return;
    }

    addLog('info', t('app.confirmationValue', { prompt, value }));
    try {
      if (isSlashCommand) {
        const res = await fetch('/api/opalatex/slash-command/continue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, value }) });
        const result = await res.json();
        if (result.status === 'done') {
          setChatMessages(prev => [...prev, { role: 'assistant', content: (result.messages || []).join('\n') || 'Comando executado.', timestamp: new Date().toISOString() }]);
          fetchFiles();
          fetchGitStatus();
        }
      } else {
        await fetch('/api/opalatex/input_response', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, value }) });
      }
    } catch (err) { addLog('error', t('app.confirmationSendError', { error: err.message })); }
  };

  // ── Editor mount ──────────────────────────────────────────────────────────
  const handleEditorDidMount = (editor, monaco) => {
    editorRef.current = editor;
    if (monaco) monacoRef.current = monaco;

    editor.onKeyDown((e) => {
      const ev = e.browserEvent;
      const isCtrl = ev.ctrlKey || ev.metaKey;
      if (isCtrl && (ev.key === '+' || ev.key === '=' || ev.code === 'Equal' || ev.code === 'NumpadAdd')) {
        ev.preventDefault(); ev.stopPropagation();
        setEditorFontSize(prev => { const v = Math.min(30, prev + 1); safeSetLocalStorage('editorFontSize', v); return v; });
      } else if (isCtrl && (ev.key === '-' || ev.code === 'Minus' || ev.code === 'NumpadSubtract')) {
        ev.preventDefault(); ev.stopPropagation();
        setEditorFontSize(prev => { const v = Math.max(10, prev - 1); safeSetLocalStorage('editorFontSize', v); return v; });
      } else if (isCtrl && ev.key === 's') {
        ev.preventDefault(); ev.stopPropagation();
        if (saveFileRef.current) saveFileRef.current();
      }
    });
  };

  // ── Inline submit — called by InlinePromptOverlay ─────────────────────────
  /**
   * Builds a context-prefixed prompt and sends it to the agent.
   * Also stores the current selection range so that auto-replace can fire
   * when the agent returns the modified code.
   */
  const handleInlineSubmit = async (instruction) => {
    if (!inlinePrompt || !activeProject) return;
    const { startLine, endLine, selectedText, mode } = inlinePrompt;

    const hasSelection = selectedText && selectedText.trim().length > 0;

    let systemPrompt, fullPrompt;
    if (mode === 'createIllustration') {
      systemPrompt = "You are a professional designer and SVG illustrator. " +
        "Your task is to generate a beautiful, clean, modern, and valid SVG illustration that visually represents the text selected by the user. " +
        "CRITICAL:\n" +
        "1. Return ONLY the raw SVG content.\n" +
        "2. The SVG MUST be valid, self-contained, and have appropriate viewBox, width, and height attributes so it renders beautifully.\n" +
        "3. Do NOT wrap the SVG in markdown code blocks like ```xml or ```svg. Return the raw SVG directly starting with <svg> and ending with </svg>.\n" +
        "4. Use a modern, appealing color scheme (like a dark theme or clean blue/purple/grey professional gradients).\n" +
        "5. Do not include any explanations, greetings, or text other than the SVG itself.\n" +
        "6. Do NOT write comments before or after the SVG.";

      fullPrompt = `Selected Text to Illustrate:\n"""\n${selectedText}\n"""\n\nUser Instruction:\n${instruction}`;
    } else {
      let verb;
      if (mode === 'refine') verb = instruction;
      else if (mode === 'fix') verb = instruction;
      else verb = instruction;

      const ext = (selectedFile || '').split('.').pop() || '';
      const fence = ext ? `\`\`\`${ext}` : '\`\`\`';

      fullPrompt = (hasSelection && mode !== 'generate')
        ? `Task: ${verb}\n\nFile Context:\n${fence}\n${fileContent}\n\`\`\`\n\nTarget Selection to Replace:\n${fence}\n${selectedText}\n\`\`\``
        : `Task: ${instruction}\n\nFile Context:\n${fence}\n${fileContent}\n\`\`\`\n\nTarget Position for Insertion: Line ${startLine}, Column ${inlinePrompt.cursorCol}. Please return ONLY the code to be inserted here.`;

      systemPrompt = "You are a precise inline content editor for any selected content: text, Markdown, LaTeX, code, config files, JSON, YAML, tables, or structured data. " +
        "CRITICAL: Do NOT create, modify, or save files. " +
        "Return ONLY the final replacement snippet wrapped in a FOUR-BACKTICK fenced block: ````content\\n...\\n````. " +
        "You MUST use exactly four backticks (````), never three (```). This is required so that inner code blocks (e.g. mermaid, latex) do not break the outer fence. " +
        "Do NOT include greetings, explanations, comments, summaries, or any text before or after the fenced block. " +
        "Preserve the original language, format, structure, and intent unless the requested edit requires changes. " +
        "Be objective, concise, and direct. Use only read-only context sources if additional context is needed. " +
        "Examples of the REQUIRED four-backtick format:\n" +
        "Original: 'O sistema é bom.' → ````content\\nO sistema é funcional.\\n```` " +
        "Original: 'flowchart LR\\n  A --> B' → ````content\\nflowchart LR\\n  A[Start] --> B[End]\\n```` " +
        "Original: '$$ E = m c ^ 2 $$' → ````content\\n$$\\nE = mc^2\\n$$\\n```` " +
        "Your entire output must be ONLY the four-backtick fenced block containing the replacement content.";
    }

    setChatInput('');
    setIsInlineRunning(true);
    setIsInlineRunning(true);
    addLog('info', t('app.inlineEditStarting', { instruction }));

    try {
      const res = await fetch('/api/opalatex/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: 'run',
          agent: 'inline_editor',
          model: activeProject.model,
          project_name: activeProject.name,
          project_path: activeProject.project_path,
          system_prompt: systemPrompt,
          tools: [],
          prompt: fullPrompt,
          current_file: selectedFile || '',
          editor_content: fileContent || '',
          selected_text: selectedText || '',
          lang: i18n.language || 'en',
          model_params: { max_tokens: 8192, ...ephemeralParams }
        }),
      });

      if (!res.body) {
        addLog('error', t('app.streamUnsupportedBackground'));
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let agentResponse = '';
      let inlineErrorMessage = '';
      const inlineAgentTool = t('app.inlineAgentTool', 'Inline agent');

      const reportInlineFailure = (message, tool = inlineAgentTool, severity = 'error') => {
        const failureMessage = message || t('app.inlineAgentNoOutput', 'Inline agent finished without producing content.');
        if (!inlineErrorMessage) {
          inlineErrorMessage = failureMessage;
          setAlertMessage(t('app.inlineAgentErrorAlert', 'OpalaTex could not generate inline content: {{message}}', { message: failureMessage }));
        }
        addProblem({ tool, message: failureMessage, severity });
        setActiveBottomTab('problems');
        setIsTerminalCollapsed(false);
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const data = JSON.parse(line);
            if (data.event === 'agent_response' && data.response) {
              agentResponse = data.response;
            } else if (data.event === 'error') {
              addLog('error', t('app.inlineAgentErrorLog', { message: data.message }));
              reportInlineFailure(data.message);
            } else if (data.event === 'problem') {
              addLog('error', t('app.toolProblem', { tool: data.tool || inlineAgentTool, message: data.message }));
              reportInlineFailure(data.message, data.tool || inlineAgentTool, data.severity || 'error');
            } else if (data.event === 'thought' || data.event === 'reflection' || data.event === 'stream_chunk') {
              let textContent = typeof data.content === 'string' ? data.content : JSON.stringify(data.content);
              if (textContent === '{}' || !textContent.trim()) continue;
              if (textContent.startsWith('{"result":') || textContent.startsWith('{"error":') || textContent.startsWith('{"name":')) continue;

              let typeName = data.event;
              addLog(typeName, textContent, data.agent);
            } else if (data.event === 'tool_call') {
              addLog('tool_call', t('app.inlineCallingTool', { tool: data.tool, arguments: JSON.stringify(data.arguments) }), data.agent);
            } else if (data.event === 'tool_result') {
              addLog('tool_result', t('app.inlineToolResult', { tool: data.tool }), data.agent);
            }
          } catch (e) {
            // ignore non-json logs
          }
        }
      }

      if (buffer.trim()) {
        try {
          const data = JSON.parse(buffer);
          if (data.event === 'agent_response' && data.response) agentResponse = data.response;
          else if (data.event === 'error') {
            addLog('error', t('app.inlineAgentErrorLog', { message: data.message }));
            reportInlineFailure(data.message);
          } else if (data.event === 'problem') {
            addLog('error', t('app.toolProblem', { tool: data.tool || inlineAgentTool, message: data.message }));
            reportInlineFailure(data.message, data.tool || inlineAgentTool, data.severity || 'error');
          }
        } catch (e) { }
      }

      if (!agentResponse) {
        reportInlineFailure(inlineErrorMessage || t('app.inlineAgentNoOutput', 'Inline agent finished without producing content.'));
        return;
      }

      if (agentResponse && editorRef.current && monacoRef.current) {
        let rawResponse = agentResponse.trim();
        rawResponse = rawResponse.replace(/\{"result"\s*:\s*"[^"]*"\}\s*/g, '');
        rawResponse = rawResponse.replace(/\{"error"\s*:\s*"[^"]*"\}\s*/g, '');

        try {
          const parsed = JSON.parse(rawResponse);
          if (parsed && parsed.name && parsed.arguments && parsed.arguments.content) {
            rawResponse = parsed.arguments.content;
          }
        } catch (e) {
          const contentMatch = rawResponse.match(/"content"\s*:\s*"([\s\S]*)/);
          if (contentMatch) {
            let str = contentMatch[1];
            str = str.replace(/\"\s*\}?\s*\}?\s*$/, '');
            str = str.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\t/g, '\t');
            rawResponse = str;
          }
        }

        // ── Strip thought/reasoning blocks ────────────────────────────────────
        // Handles both 4-backtick (new) and 3-backtick (legacy) thought fences.
        // No `m` flag: ^ anchors to the START of the full string, not any line.
        // Uses greedy [\s\S]* to consume the entire block even if it contains
        // nested ``` inside — avoids the non-greedy stop-at-first-``` bug.
        rawResponse = rawResponse
          .replace(/^````(?:thought|reasoning)[\s\S]*?````\s*/, '')
          .replace(/^```(?:thought|reasoning)[\s\S]*?```\s*/, '')
          .trim();

        // ── Depth-aware code block extractor ─────────────────────────────────
        // Correctly handles content that contains nested ``` fences (mermaid,
        // latex, code examples, etc.) by tracking fence depth instead of using
        // a simple non-greedy regex that stops at the first ``` found.
        function extractOutermostCodeBlock(text) {
          const lines = text.split('\n');
          let outerFence = null;   // e.g. '````' or '```'
          let depth = 0;
          const bodyLines = [];
          let insideOuter = false;

          for (const line of lines) {
            // A fence line starts with optional spaces (≤3) then 3+ backticks/tildes
            const fm = line.match(/^( {0,3})(```+|~~~+)(\w*)/);

            if (!insideOuter) {
              if (fm) {
                outerFence = fm[2];  // the opening fence chars, e.g. '````'
                depth = 1;
                insideOuter = true;
                // Do NOT push this line — it's the opening fence delimiter
              }
              continue;
            }

            // Inside the outer block: track nested fences
            if (fm) {
              const thisFence = fm[2];
              const hasLabel = fm[3].length > 0;

              if (!hasLabel && thisFence.startsWith(outerFence)) {
                // Potential closing fence (same or more backticks, no language label)
                depth--;
                if (depth === 0) break; // real closing fence — stop
              } else if (hasLabel) {
                // Opening of a nested block (has a language label)
                depth++;
              }
              // A closing fence for a nested block (no label, fewer backticks):
              // depth-- only when it matches outerFence length, so inner ``` inside
              // a ```` outer are just regular lines.
            }

            bodyLines.push(line);
          }

          if (!insideOuter || depth !== 0) return null; // no valid block found
          // Strip trailing blank lines that were before the closing fence
          while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1].trim() === '') {
            bodyLines.pop();
          }
          return bodyLines.join('\n');
        }

        if (mode === 'createIllustration') {
          let svgCode = rawResponse;

          // Try to extract content inside code blocks if present
          const svgMatch = /```(?:xml|svg)?\s*([\s\S]*?)```/i.exec(svgCode) || /````(?:xml|svg)?\s*([\s\S]*?)````/i.exec(svgCode);
          if (svgMatch) {
            svgCode = svgMatch[1].trim();
          } else {
            const tagMatch = /<svg[\s\S]*<\/svg>/i.exec(svgCode);
            if (tagMatch) {
              svgCode = tagMatch[0].trim();
            }
          }

          if (!svgCode.startsWith('<svg')) {
            const svgStart = svgCode.indexOf('<svg');
            if (svgStart !== -1) {
              svgCode = svgCode.substring(svgStart);
            }
          }

          if (!svgCode.includes('<svg') || !svgCode.includes('</svg>')) {
            throw new Error(t('app.invalidSvgReturned'));
          }

          const timestamp = Math.floor(Date.now() / 1000);
          const filename = `illustrations/illustration_${timestamp}.svg`;

          // ── Robust project-relative path normalizer ─────────────────────────
          // Handles all formats of selectedFile: relative ("d1/A.tex"),
          // backslash ("d1\\A.tex"), or absolute Windows ("C:\\Users\\...\\d1\\A.tex").
          // Returns a clean forward-slash relative path like "d1/A.tex".
          function toProjectRelativePath(filePath, projectPath) {
            if (!filePath) return '';
            let norm = filePath.replace(/\\/g, '/');

            // Strip project root prefix if selectedFile is absolute
            if (projectPath) {
              const projNorm = projectPath.replace(/\\/g, '/').replace(/\/+$/, '') + '/';
              // Case-insensitive comparison needed on Windows
              if (norm.toLowerCase().startsWith(projNorm.toLowerCase())) {
                norm = norm.substring(projNorm.length);
              }
            }

            // Remove any remaining drive letter (e.g., "C:/") or leading slashes
            norm = norm.replace(/^[A-Za-z]:\//, '').replace(/^\/+/, '');
            return norm;
          }

          const relSelectedFile = toProjectRelativePath(selectedFile, activeProject?.project_path);
          const dirSegments = relSelectedFile.split('/').filter(Boolean).slice(0, -1); // directory parts only
          const depth = dirSegments.length;
          const relPrefix = depth > 0 ? '../'.repeat(depth) : '';
          const relIllustrationPath = `${relPrefix}illustrations/illustration_${timestamp}`;

          addLog('info', t('app.savingSvg', { path: filename }));
          const writeRes = await fetch('/api/file/write', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              projectPath: activeProject.project_path,
              filePath: filename,
              content: svgCode,
            }),
          });
          if (!writeRes.ok) {
            const errData = await writeRes.json().catch(() => ({}));
            throw new Error(t('app.svgSaveFailed', { error: errData.error || writeRes.statusText }));
          }

          const model = editorRef.current.getModel();
          const endCol = model ? model.getLineMaxColumn(endLine) : 1;
          const range = new monacoRef.current.Range(startLine, 1, endLine, endCol);
          const fullLinesText = model.getValueInRange(range);

          const ext = (selectedFile || '').split('.').pop().toLowerCase();
          let refText = '';
          let adjustedEndLine = endLine;
          if (ext === 'tex') {
            // Ensure \usepackage{graphicx} is in the preamble
            const fullContent = model.getValue();
            if (!fullContent.includes('usepackage{graphicx}')) {
              const docIdx = fullContent.indexOf('\\begin{document}');
              if (docIdx !== -1) {
                const insertPos = model.getPositionAt(docIdx);
                editorRef.current.executeEdits('opalatex_graphicx', [{
                  range: new monacoRef.current.Range(insertPos.lineNumber, 1, insertPos.lineNumber, 1),
                  text: '\\usepackage{graphicx}\n\n',
                  forceMoveMarkers: true,
                }]);
                // Shift endLine after preamble insertion
                adjustedEndLine += 2;
              }
            }
            refText = `\\begin{figure}[htbp]\n\\centering\n\\includegraphics[width=0.8\\textwidth]{${relIllustrationPath}.pdf}\n\\end{figure}`;
          } else if (ext === 'md' || ext === 'markdown') {
            // Markdown preview in OpalaTex resolves paths from the project root,
            // so always use root-relative path regardless of file depth
            refText = `![Ilustração](illustrations/illustration_${timestamp}.svg)`;
          } else if (ext === 'html' || ext === 'htm') {
            refText = `<img src="${relIllustrationPath}.svg" alt="Ilustração" />`;
          } else {
            refText = `${relIllustrationPath}.svg`;
          }

          // Re-read range after potential preamble insertion shift
          const updatedEndCol = model.getLineMaxColumn(adjustedEndLine);
          const updatedRange = new monacoRef.current.Range(startLine, 1, adjustedEndLine, updatedEndCol);
          const updatedText = model.getValueInRange(updatedRange);

          const separator = updatedText.endsWith('\n') ? '' : '\n';
          const codeToInsert = updatedText + separator + '\n' + refText + '\n';

          editorRef.current.executeEdits('opalatex_inline', [{
            range: updatedRange,
            text: codeToInsert,
            forceMoveMarkers: true,
          }]);
          addLog('info', t('app.svgCreatedInserted'));
        } else {
          // ── Extraction pipeline ───────────────────────────────────────────────
          let codeToInsert;

          // 1) PRIMARY: 4-backtick outer fence (simple regex is safe because inner
          //    ``` cannot close a ```` fence — CommonMark spec §4.5).
          const match4 = /^````(\w*)\n([\s\S]*?)\n````\s*$/m.exec(rawResponse);
          if (match4) {
            codeToInsert = match4[2];

            // 2) FALLBACK: depth-aware parser handles any 3-backtick fence whose body
            //    may contain nested ``` blocks (model ignored the 4-backtick instruction).
          } else {
            const extracted = extractOutermostCodeBlock(rawResponse);
            if (extracted !== null) {
              codeToInsert = extracted;

              // 3) LAST RESORT: strip leading/trailing fence markers manually so at
              //    least the raw fence delimiters don't end up in the editor.
            } else {
              codeToInsert = rawResponse
                .replace(/^````?\w*\n?/, '')  // strip opening fence line
                .replace(/\n?````?\s*$/, '')  // strip closing fence line
                .trim();
            }
          }

          if (mode === 'generate') {
            const range = new monacoRef.current.Range(startLine, inlinePrompt.cursorCol, startLine, inlinePrompt.cursorCol);
            const model = editorRef.current.getModel();
            editorRef.current.executeEdits('opalatex_inline', [{
              range: range,
              text: normalizeInlineReplacementSpacing(codeToInsert, '', model?.getEOL?.() || '\n'),
              forceMoveMarkers: true,
            }]);
            addLog('info', t('app.inlineGenerationApplied'));
          } else if (hasSelection) {
            // Calculate end column dynamically
            const model = editorRef.current.getModel();
            const endCol = model ? model.getLineMaxColumn(endLine) : 1;

            const range = new monacoRef.current.Range(startLine, 1, endLine, endCol);
            const originalText = model ? model.getValueInRange(range) : selectedText;
            const normalizedCode = normalizeInlineReplacementSpacing(
              codeToInsert,
              originalText,
              model?.getEOL?.() || '\n',
            );
            editorRef.current.executeEdits('opalatex_inline', [{
              range: range,
              text: normalizedCode,
              forceMoveMarkers: true,
            }]);
            addLog('info', t('app.inlineEditApplied'));
          }
        }
      }

    } catch (err) {
      addLog('error', t('app.inlineEditFailed', { error: err.message }));
      addProblem({ tool: t('app.inlineAgentTool', 'Inline agent'), message: err.message, severity: 'error' });
      setActiveBottomTab('problems');
      setIsTerminalCollapsed(false);
      setAlertMessage(t('app.inlineAgentErrorAlert', 'OpalaTex could not generate inline content: {{message}}', { message: err.message }));
    } finally {
      setInlinePrompt(null);
      setIsInlineRunning(false);
      fetchFiles();
      fetchProblems();
    }
  };

  /**
   * Variant of handleSendMessage that accepts an explicit prompt string.
   * Used by handleInlineSubmit to bypass the chatInput state timing.
   * @param {string} userText   - The full prompt to send to the agent.
   * @param {string} [capturedSelectedText] - The text captured at submit time
   *   (avoids re-reading Monaco selection which may be gone by now).
   */
  const handleSendMessageWithPrompt = async (userText, capturedSelectedText) => {
    try {
      const r = await fetch('/api/settings/ai-provider');
      if (r.ok) {
        const cfg = await r.json();
        if (cfg.provider === 'cloud') {
          const balRes = await fetch('/api/settings/token-balance');
          if (balRes.ok) {
            const balData = await balRes.json();
            if (!balData || balData.balance === undefined || balData.balance <= 0) {
              alert(t('common.noCredits', 'Sem saldo suficiente para usar a cloud. Por favor adicione créditos.'));
              return;
            }
          }
        }
      }
    } catch (_) { }
    if (!userText.trim() || !activeProject || isAgentRunning) return;
    setChatInput('');
    setChatMessages(prev => [...prev, { role: 'user', content: userText, timestamp: new Date().toISOString() }]);
    setIsAgentRunning(true);
    setProblems([]);
    chatThoughtStreamRef.current = '';
    setChatThoughtStream('');
    addLog('info', t('app.starting', { text: `${userText.slice(0, 80)}${userText.length > 80 ? '...' : ''}` }))

    // Use the captured text if provided; otherwise try reading Monaco
    let selectedText = capturedSelectedText ?? '';
    if (!selectedText && editorRef.current) {
      try {
        const model = editorRef.current.getModel();
        const sel = editorRef.current.getSelection();
        if (model && sel) selectedText = model.getValueInRange(sel);
      } catch (e) { }
    }

    try {
      const res = await fetch('/api/opalatex/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'run', agent: 'chat_orchestrator', prompt: userText, project_name: activeProject.name, project_path: activeProject.project_path, model: activeProject.model, current_file: selectedFile || '', editor_content: fileContent || '', selected_text: selectedText || '', lang: i18n.language || 'en', chat_id: activeChatId, model_params: ephemeralParams }),
      });
      if (!res.body) { addLog('error', t('app.streamUnsupportedBackend')); setIsAgentRunning(false); return; }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try { handleAgentEvent(JSON.parse(line)); } catch (e) { addLog('stdout', line); }
        }
      }
      if (buffer.trim()) { try { handleAgentEvent(JSON.parse(buffer)); } catch (e) { addLog('stdout', buffer); } }
    } catch (err) {
      addLog('error', t('app.executionFailed', { error: err.message }));
      setChatMessages(prev => [...prev, { role: 'assistant', content: `🔴 Falha na execução: ${err.message}`, timestamp: new Date().toISOString() }]);
    } finally { setIsAgentRunning(false); fetchFiles(); fetchProblems(); }
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="vscode-app">
      <input
        ref={importFileInputRef}
        type="file"
        style={{ display: 'none' }}
        onChange={handleImportFileSelected}
      />
      <div className="vscode-main">

        {/* Activity Bar */}
        <ActivityBar
          activeSidebarTab={activeSidebarTab}
          setActiveSidebarTab={(tab) => {
            setActiveSidebarTab(tab);
            if (isEditorMaximized) setIsEditorMaximized(false);
          }}
          isChatVisible={isChatVisible}
          setIsChatVisible={(val) => {
            setIsChatVisible(val);
            if (isEditorMaximized) setIsEditorMaximized(false);
          }}
          gitChangesCount={gitChanges.length}
          onOpenSettings={() => setIsSettingsOpen(true)}
          onOpenHardware={() => setIsHardwareModalOpen(true)}
          layoutMode={layoutMode}
          setLayoutMode={setLayoutMode}
          isTerminalCollapsed={isTerminalCollapsed}
          setIsTerminalCollapsed={setIsTerminalCollapsed}
        />

        {/* Left Sidebar */}
        {!isEditorMaximized && activeSidebarTab && layoutMode === 'ide' && (
          <aside className="vscode-sidebar" style={{ width: `${sidebarWidth}px` }}>
            {activeSidebarTab === 'explorer' ? (
              <ExplorerSidebar
                projects={projects}
                activeProject={activeProject}
                handleSelectProject={handleSelectProject}
                onNewProject={() => { setShowNewProjectModal(true); setNewProjModelParams({}); }}
                onImportProject={() => { setImportError(''); openDirPicker('import', '~'); }}
                importError={importError}
                onClearImportError={() => setImportError('')}
                files={files}
                selectedFile={selectedFile}
                selectedNodes={selectedNodes}
                fileContents={fileContents}
                originalFileContents={originalFileContents}
                handleNodeSelect={handleNodeSelect}
                handleFileSelect={handleFileSelect}
                handleNodeContextMenu={handleNodeContextMenu}
                handleWorkspaceContextMenu={handleWorkspaceContextMenu}
                draggedNode={draggedNode}
                setDraggedNode={setDraggedNode}
                dragOverPath={dragOverPath}
                setDragOverPath={setDragOverPath}
                handleMoveNode={handleMoveNode}
                fetchFiles={fetchFiles}
                openEditModal={openEditModal}
                handleDeleteProject={handleDeleteProject}
              />
            ) : (
              <GitSidebar
                activeProject={activeProject}
                gitChanges={gitChanges}
                fetchGitStatus={fetchGitStatus}
                commitMessage={commitMessage}
                setCommitMessage={setCommitMessage}
                isCommitting={isCommitting}
                handleGitCommit={handleGitCommit}
                onStageFile={handleStageFile}
                onUnstageFile={handleUnstageFile}
                onDiscardFile={handleDiscardFile}
                useShadowGit={useShadowGit}
                setUseShadowGit={setUseShadowGit}
                gitRootPath={currentGitRootPath}
                onPickGitRoot={() => openDirPicker('git-root', currentGitRootPath || activeProject?.project_path || '~')}
                onClearGitRoot={() => updateActiveGitRoot('')}
              />
            )}
          </aside>
        )}

        {/* Chat Sidebar (Only in Chat Mode) */}
        {!isEditorMaximized && layoutMode === 'chat' && (
          <aside className="vscode-sidebar" style={{ width: `${sidebarWidth}px`, display: 'flex', flexDirection: 'column' }}>
            <div className="vscode-chat-sidebar-history-pane">
              <ChatSidebar
                chats={chats}
                activeChatId={activeChatId}
                setActiveChatId={setActiveChatId}
                setChats={setChats}
                activeProject={activeProject}
                setChatMessages={setChatMessages}
                onSwitchChat={handleSwitchChat}
              />
            </div>

            <div className="vscode-chat-sidebar-divider" />

            <div className="vscode-chat-sidebar-explorer-pane">
              <ExplorerSidebar
                projects={projects}
                activeProject={activeProject}
                handleSelectProject={handleSelectProject}
                onNewProject={() => { setShowNewProjectModal(true); setNewProjModelParams({}); }}
                onImportProject={() => { setImportError(''); openDirPicker('import', '~'); }}
                importError={importError}
                onClearImportError={() => setImportError('')}
                files={files}
                selectedFile={selectedFile}
                selectedNodes={selectedNodes}
                fileContents={fileContents}
                originalFileContents={originalFileContents}
                handleNodeSelect={handleNodeSelect}
                handleFileSelect={handleFileSelect}
                handleNodeContextMenu={handleNodeContextMenu}
                handleWorkspaceContextMenu={handleWorkspaceContextMenu}
                draggedNode={draggedNode}
                setDraggedNode={setDraggedNode}
                dragOverPath={dragOverPath}
                setDragOverPath={setDragOverPath}
                handleMoveNode={handleMoveNode}
                fetchFiles={fetchFiles}
                openEditModal={openEditModal}
                handleDeleteProject={handleDeleteProject}
              />
            </div>
          </aside>
        )}

        {/* Left resize handle */}
        {!isEditorMaximized && ((activeSidebarTab && layoutMode === 'ide') || layoutMode === 'chat') && (
          <div className="vscode-resizer-horizontal" onMouseDown={(e) => startResizing(e, 'left')} />
        )}

        {/* Center — Editor + Bottom Panel */}
        <main className="vscode-editor-panel" style={{ flex: layoutMode === 'chat' ? 0 : 1, display: layoutMode === 'chat' ? 'none' : 'flex' }}>
          {!isBottomMaximized && layoutMode === 'review' && (
            <GitSidebar
              activeProject={activeProject}
              gitChanges={gitChanges}
              fetchGitStatus={fetchGitStatus}
              commitMessage={commitMessage}
              setCommitMessage={setCommitMessage}
              isCommitting={isCommitting}
              handleGitCommit={handleGitCommit}
              onStageFile={handleStageFile}
              onUnstageFile={handleUnstageFile}
              onDiscardFile={handleDiscardFile}
              useShadowGit={true}
              setUseShadowGit={() => {}}
              gitRootPath=""
              onPickGitRoot={() => {}}
              onClearGitRoot={() => {}}
              reviewMode
              onAfterRestore={handleCheckpointRestored}
            />
          )}

          {!isBottomMaximized && layoutMode === 'ide' && (
            <EditorPanel
              selectedFile={selectedFile}
              openFiles={openFiles}
              fileContent={fileContent}
              fileContents={fileContents}
              originalFileContents={originalFileContents}
              isSaving={isSaving}
              theme={theme}
              editorFontSize={editorFontSize}
              setEditorFontSize={setEditorFontSize}
              editorTabSize={editorTabSize}
              editorWordWrap={editorWordWrap}
              handleFileSelect={handleFileSelect}
              handleCloseTab={handleCloseTab}
              saveFile={saveFile}
              handleEditorDidMount={handleEditorDidMount}
              setFileContent={setFileContent}
              jumpToLine={jumpToLine}
              setJumpToLine={setJumpToLine}
              isMaximized={isEditorMaximized}
              onToggleMaximize={() => setIsEditorMaximized(!isEditorMaximized)}
              inlinePrompt={inlinePrompt}
              setInlinePrompt={setInlinePrompt}
              onInlineSubmit={handleInlineSubmit}
              isInlineRunning={isInlineRunning}
              onInlineCancel={() => {
                fetch('/api/opalatex/interrupt', { method: 'POST' }).catch(() => { });
                setIsInlineRunning(false);
              }}
              onToggleTerminal={() => {
                if (isEditorMaximized) {
                  setIsEditorMaximized(false);
                  setIsTerminalCollapsed(false);
                  setActiveBottomTab('terminal');
                  setBottomPanelHeight(Math.floor(window.innerHeight / 2));
                  return;
                }
                if (isTerminalCollapsed) {
                  setIsTerminalCollapsed(false);
                  setActiveBottomTab('terminal');
                } else if (activeBottomTab === 'terminal') {
                  setIsTerminalCollapsed(true);
                } else {
                  setActiveBottomTab('terminal');
                }
              }}
              activeProject={activeProject}
              triggerCompileRequest={triggerCompileRequest}
              onBinaryFileSaved={(filePath) => {
                addLog('info', t('app.fileSaved', { path: filePath }));
                fetchGitStatus();
                fetchProblems();
              }}
              onRegisterBinarySave={(handler) => {
                binarySaveHandlerRef.current = handler;
              }}
            />
          )}

          <div style={{ display: isEditorMaximized || layoutMode !== 'ide' ? 'none' : 'contents' }}>
            <BottomPanel
              activeBottomTab={activeBottomTab}
              setActiveBottomTab={setActiveBottomTab}
              isTerminalCollapsed={isTerminalCollapsed}
              setIsTerminalCollapsed={setIsTerminalCollapsed}
              terminalLogs={terminalLogs}
              setTerminalLogs={setTerminalLogs}
              problems={problems}
              setProblems={setProblems}
              achievementsMemory={achievementsMemory}
              bottomPanelHeight={bottomPanelHeight}
              activeProject={activeProject}
              terminalRef={terminalRef}
              terminalInstanceRef={terminalInstanceRef}
              logEndRef={logEndRef}
              startResizing={startResizing}
              isBottomMaximized={isBottomMaximized}
              onToggleMaximizeBottom={() => setIsBottomMaximized(!isBottomMaximized)}
              theme={theme}
            />
          </div>
        </main>

        {/* Right resize handle */}
        {!isEditorMaximized && isChatVisible && layoutMode === 'ide' && (
          <div className="vscode-resizer-horizontal" onMouseDown={(e) => startResizing(e, 'right')} />
        )}

        {/* Chat Panel */}
        {(!isEditorMaximized && layoutMode !== 'review' && (isChatVisible || layoutMode === 'chat')) && (
          <>
            <ChatPanel
              isChatMode={layoutMode === 'chat'}
              chatMessages={chatMessages}
              chatInput={chatInput}
              setChatInput={setChatInput}
              isAgentRunning={isAgentRunning}
              chatThoughtStream={chatThoughtStream}
              activeProject={activeProject}
              isChatVisible={isChatVisible}
              setIsChatVisible={setIsChatVisible}
              chatWidth={chatWidth}
              handleSendMessage={handleSendMessage}
              onEditUserMessage={handleEditUserMessage}
              onGenerateResponseForUserMessage={handleGenerateResponseForUserMessage}
              handleInterruptAgent={handleInterruptAgent}
              onClearChat={() => {
                const currentProjName = activeProject ? (activeProject.project_name || activeProject.name) : '';
                setChatMessages(currentProjName ? [
                  { role: 'assistant', content: t('app.greeting', { projectName: currentProjName }) }
                ] : []);
              }}
              chatEndRef={chatEndRef}
              webSearchConfig={webSearchConfig}
              setWebSearchConfig={setWebSearchConfig}
              activeChatId={activeChatId}
              setActiveChatId={setActiveChatId}
              chats={chats}
              setChats={setChats}
              setChatMessages={setChatMessages}
              onSwitchChat={handleSwitchChat}
              pendingAttachments={pendingAttachments}
              setPendingAttachments={setPendingAttachments}
              globalModels={globalModels}
              onRefreshModels={fetchGlobalModels}
              onEditModels={() => setShowEditModelsModal(true)}
              onModelChange={handleProjectModelChange}
              globalAiProvider={globalAiProvider}
            />

            {(isLoadingChat || isPending) && (
              <div style={{
                position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
                backgroundColor: 'rgba(0,0,0,0.5)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                zIndex: 50, color: 'var(--vscode-editor-foreground)',
                flexDirection: 'column', gap: '10px'
              }}>
                <div className="spinner" style={{
                  width: '30px', height: '30px', border: '3px solid rgba(255,255,255,0.3)',
                  borderRadius: '50%', borderTopColor: '#fff', animation: 'spin 1s ease-in-out infinite'
                }}></div>
                <style>{`
                @keyframes spin { to { transform: rotate(360deg); } }
              `}</style>
                <span>{t('app.loadingChat')}</span>
              </div>
            )}
          </>
        )}
      </div>

      {/* Status Bar */}
      <StatusBar
        activeProject={activeProject}
        isAgentRunning={isAgentRunning}
        licenseData={licenseData}
        onOpenLicense={() => setShowLicenseModal(true)}
      />

      {/* ── Overlays / Modals ── */}

      <AlertModal message={alertMessage} onClose={() => setAlertMessage('')} />

      {showInstallPrompt && (
        <InstallDepsPrompt
          onClose={() => setShowInstallPrompt(false)}
          onInstall={() => { setShowInstallPrompt(false); setIsSettingsOpen(true); setSettingsTab('preferences'); handleInstallOptionalDeps(); }}
        />
      )}

      {showNewProjectModal && (
        <NewProjectModal
          globalAiProvider={globalAiProvider}
          globalCloudModel={globalCloudModel}
          globalModels={globalModels}
          onClose={() => setShowNewProjectModal(false)}
          onSubmit={handleCreateProject}
          newProjName={newProjName} setNewProjName={setNewProjName}
          newProjPath={newProjPath} setNewProjPath={setNewProjPath}
          newProjDesc={newProjDesc} setNewProjDesc={setNewProjDesc}
          newProjModel={newProjModel} setNewProjModel={setNewProjModel}
          newProjWorkerModel={newProjWorkerModel} setNewProjWorkerModel={setNewProjWorkerModel}
          newProjMode={newProjMode} setNewProjMode={setNewProjMode}
          newProjApiKey={newProjApiKey} setNewProjApiKey={setNewProjApiKey}
          newProjApiBase={newProjApiBase} setNewProjApiBase={setNewProjApiBase}
          newProjWorkerApiKey={newProjWorkerApiKey} setNewProjWorkerApiKey={setNewProjWorkerApiKey}
          newProjWorkerApiBase={newProjWorkerApiBase} setNewProjWorkerApiBase={setNewProjWorkerApiBase}
          newProjModelParams={newProjModelParams} setNewProjModelParams={setNewProjModelParams}
          newProjWorkerModelParams={newProjWorkerModelParams} setNewProjWorkerModelParams={setNewProjWorkerModelParams}
          newProjError={newProjError}
          onOpenDirPicker={openDirPicker}
        />
      )}

      {editingProject && (
        <EditProjectModal
          globalAiProvider={globalAiProvider}
          globalCloudModel={globalCloudModel}
          globalModels={globalModels}
          editingProject={editingProject}
          setEditingProject={setEditingProject}
          onClose={() => setEditingProject(null)}
          onSubmit={handleUpdateProject}
          editProjError={editProjError}
          showAdvancedParams={showAdvancedParams}
          setShowAdvancedParams={setShowAdvancedParams}
          onOpenDirPicker={openDirPicker}
        />
      )}

      {isSettingsOpen && (
        <SettingsModal
          globalCloudModel={globalCloudModel}
          onCloudModelChange={(val) => setGlobalCloudModel(normalizeCloudModelId(val))}
          onAiProviderChange={(val) => setGlobalAiProvider(val)}
          onClose={() => setIsSettingsOpen(false)}
          settingsTab={settingsTab}
          setSettingsTab={setSettingsTab}
          theme={theme} setTheme={setTheme}
          editorFontSize={editorFontSize} setEditorFontSize={setEditorFontSize}
          editorTabSize={editorTabSize} setEditorTabSize={setEditorTabSize}
          editorWordWrap={editorWordWrap} setEditorWordWrap={setEditorWordWrap}
          isInstallingDeps={isInstallingDeps}
          installDepsStatus={installDepsStatus}
          installDepsLog={installDepsLog}
          onInstallDeps={handleInstallOptionalDeps}
          ephemeralParams={ephemeralParams}
          setEphemeralParams={setEphemeralParams}
          panelMaxLines={panelMaxLines}
          setPanelMaxLines={(val) => { setPanelMaxLines(val); safeSetLocalStorage('panelMaxLines', val); }}
          licenseData={licenseData}
          onReplaceSerial={() => setShowLicenseModal(true)}
          onLanguageChange={(lang) => {
            fetch('/api/settings/language', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ lang }),
            }).catch(() => { });
          }}
        />
      )}

      {isHardwareModalOpen && (
        <HardwareModal onClose={() => setIsHardwareModalOpen(false)} />
      )}

      {showOnboarding && <OnboardingModal onComplete={handleOnboardingComplete} />}
      <LicenseModal
        licenseData={licenseData}
        isOpen={showLicenseModal}
        onClose={() => {
          setShowLicenseModal(false);
          // Reload registration data after activation or account changes.
          fetch('/api/license/status').then(r => r.json()).then(d => {
            setLicenseData(d);
          });
        }}
      />

      {confirmRequest && confirmRequest.type === 'interactive_terminal' ? (
        <InteractiveTerminalModal request={confirmRequest} onConfirm={sendConfirmResponse} activeProject={activeProject} />
      ) : confirmRequest && confirmRequest.type === 'ask' ? (
        <AskModal askRequest={confirmRequest} onConfirm={sendConfirmResponse} />
      ) : confirmRequest ? (
        <ConfirmModal confirmRequest={confirmRequest} onConfirm={sendConfirmResponse} />
      ) : null}

      <DeleteProjectModal
        projectToDelete={projectToDelete}
        onCancel={() => setProjectToDelete(null)}
        onConfirm={confirmDeleteProject}
      />

      <DirPickerModal
        dirPicker={dirPicker}
        onNavigate={navigateDirPicker}
        onConfirm={confirmDirPicker}
        onClose={() => setDirPicker(null)}
      />

      <ContextMenu
        contextMenu={contextMenu}
        rightClickedNode={rightClickedNode}
        handleCreateNewFile={handleCreateNewFile}
        handleCreateNewDir={handleCreateNewDir}
        handleImportFile={handleImportFile}
        handleRenameNode={handleRenameNode}
        handleDeleteNode={handleDeleteNode}
        handleCopyNode={handleCopyNode}
        handlePasteNode={handlePasteNode}
        handleOpenInSystem={handleOpenInSystem}
        handleSetMainFile={handleSetMainFile}
        clipboardNode={clipboardNode}
      />

      {showEditModelsModal && (
        <EditModelsModal
          globalModels={globalModels}
          onClose={() => setShowEditModelsModal(false)}
          onDeleteModel={handleGlobalModelDelete}
          onEditModel={(model) => {
            setEditingModelModalData(model);
            setShowAddProviderModal(true);
          }}
          onAddProvider={() => {
            setEditingModelModalData(null);
            setShowAddProviderModal(true);
          }}
        />
      )}

      {showAddProviderModal && (
        <AddProviderModal
          editingModel={editingModelModalData}
          existingModels={globalModels}
          onClose={() => setShowAddProviderModal(false)}
          onSave={handleGlobalModelSave}
        />
      )}
    </div>
  );
}
