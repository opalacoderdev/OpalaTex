import React, { useState, useEffect, useMemo, useRef, useCallback, useTransition } from 'react';
import '@xterm/xterm/css/xterm.css';
import { useTranslation } from 'react-i18next';
import i18n from './i18n/index.js';

// Utils
import { safeGetLocalStorage, safeSetLocalStorage } from './utils/storage';
import { UI_SCALE_DEFAULT, UI_SCALE_KEY_STEP, clampUiScale, roundUiScale, viewportPointToApp, viewportPxToApp } from './utils/uiScale';
import { layoutAfterOpeningFile, layoutShowsEditor } from './utils/layoutModes';

// Hooks
import { useResizing } from './hooks/useResizing';
import { useModelCatalog } from './contexts/ModelCatalogProvider.jsx';

// Layout components
import ActivityBar from './components/ActivityBar';
import StatusBar from './components/StatusBar';
import ExplorerSidebar from './components/ExplorerSidebar';
import GitSidebar from './components/GitSidebar';
import EditorPanel from './components/EditorPanel';
import ChatPanel from './components/ChatPanel';
import ChatSidebar from './components/ChatSidebar';
import {
  STUDIO_BOTTOM_HEIGHT_DEFAULT,
  STUDIO_CHAT_WIDTH_DEFAULT,
  studioGridTemplate,
} from './utils/studioLayout';
import BottomPanel from './components/BottomPanel';
import ContextMenu from './components/ContextMenu';
import MoveToModal from './components/MoveToModal';

// Modals
import InstallDepsPrompt from './components/modals/InstallDepsPrompt';
import NewProjectModal from './components/modals/NewProjectModal';
import EditProjectModal from './components/modals/EditProjectModal';
import SettingsModal from './components/modals/SettingsModal';
import ConfirmModal from './components/modals/ConfirmModal';
import PlanPanel from './components/PlanPanel';
import AlertModal from './components/modals/AlertModal';
import InteractiveTerminalModal from './components/modals/InteractiveTerminalModal';
import AskModal from './components/modals/AskModal';
import HardwareModal from './components/modals/HardwareModal';
import AssetStoreModal from './components/modals/AssetStoreModal';
import CloudSyncModal from './components/modals/CloudSyncModal';
import CloudDownloadModal from './components/modals/CloudDownloadModal';
import OnboardingModal from './components/modals/OnboardingModal';
import DirPickerModal from './components/modals/DirPickerModal';
import DeleteProjectModal from './components/modals/DeleteProjectModal';

import EditModelsModal from './components/modals/EditModelsModal';
import AddModelModal from './components/modals/AddModelModal';
import EditProvidersModal from './components/modals/EditProvidersModal';
import AddConnectionModal from './components/modals/AddConnectionModal';

const numericMessageId = (message) => {
  if (message?.id === undefined || message?.id === null || message.id === '') return null;
  const parsed = Number(message.id);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

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

const extractInlineReplacementBlock = (text) => {
  const source = String(text || '').trim();
  const lines = source.split('\n');
  const blocks = [];

  for (let index = 0; index < lines.length; index += 1) {
    const opening = lines[index].match(/^( {0,3})(`{3,}|~{3,})([^\r\n]*)$/);
    if (!opening) continue;

    const fence = opening[2];
    const fenceChar = fence[0];
    const fenceLength = fence.length;
    const info = opening[3].trim().split(/\s+/)[0].toLowerCase();
    const bodyLines = [];

    index += 1;
    for (; index < lines.length; index += 1) {
      const closingPattern = fenceChar === '`'
        ? /^( {0,3})(`{3,})(\s*)$/
        : /^( {0,3})(~{3,})(\s*)$/;
      const closing = lines[index].match(closingPattern);
      if (closing && closing[2].length >= fenceLength) {
        blocks.push({
          fenceLength,
          info,
          content: bodyLines.join('\n').replace(/\n+$/, ''),
        });
        break;
      }
      bodyLines.push(lines[index]);
    }
  }

  if (!blocks.length) return null;
  const contentBlock = blocks.find(block => block.info === 'content');
  if (contentBlock) return contentBlock.content;
  const fourTickBlock = blocks.find(block => block.fenceLength >= 4);
  if (fourTickBlock) return fourTickBlock.content;
  return blocks[blocks.length - 1].content;
};

const isBinaryEditorFile = (filePath) => {
  if (!filePath) return false;
  return /\.pdf$/i.test(String(filePath));
};

const SYSTEM_APP_EXTENSIONS = new Set([
  // Images
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'tiff', 'tif', 'psd', 'ai', 'raw', 'cr2', 'nef', 'heic', 'heif',
  // Audio
  'mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'wma', 'opus', 'mid', 'midi',
  // Video
  'mp4', 'webm', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'm4v', '3gp',
  // Archives
  'zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'tgz', 'iso', 'cab', 'dmg', 'pkg',
  // Non-supported Office / Documents
  'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'xlsm', 'odt', 'ods', 'odp', 'epub', 'pages', 'numbers', 'key',
  // Executables / Binaries / Compiled / Database / Libraries
  'exe', 'dll', 'so', 'dylib', 'bin', 'dat', 'db', 'sqlite', 'sqlite3', 'pyc', 'pyo', 'pyd', 'o', 'obj', 'a', 'lib', 'class', 'jar', 'war', 'ear', 'apk', 'msi', 'deb', 'rpm'
]);

const isUnsupportedSystemFile = (filePath) => {
  if (!filePath) return false;
  const parts = String(filePath).split('.');
  if (parts.length <= 1) return false;
  const ext = parts.pop().toLowerCase();
  return SYSTEM_APP_EXTENSIONS.has(ext);
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
  // Word/character statistics reported by the editor panel (mode-aware:
  // LaTeX, Markdown or plain text), rendered in the status bar.
  const [editorTextStats, setEditorTextStats] = useState(null);
  const [selectedNodes, setSelectedNodes] = useState(new Set());
  const [renamingNodePath, setRenamingNodePath] = useState(null);
  const [fileContent, setFileContent] = useState('');
  // Always-current ref for fileContent — used in async closures and useEffect
  // callbacks where capturing fileContent directly would produce a stale value.
  // Assigning here (outside any hook) keeps it in sync on every render without
  // adding fileContent to useEffect dependency arrays.
  const fileContentRef = useRef('');
  const [openFiles, setOpenFiles] = useState([]);
  const [fileContents, setFileContents] = useState({});
  const [originalFileContents, setOriginalFileContents] = useState({});
  const [rightClickedNode, setRightClickedNode] = useState(null);
  const [isSaving, setIsSaving] = useState(false);

  // ── Chat / agent ──────────────────────────────────────────────────────────
  const [chatMessages, setChatMessages] = useState([]);
  const [chatThoughtStream, setChatThoughtStream] = useState('');
  const chatThoughtStreamRef = useRef('');
  const [chatResponseStream, setChatResponseStream] = useState('');
  const chatResponseStreamRef = useRef('');
  // Provider-reported occupancy of the orchestrator context window, emitted by
  // the backend after every LLM call. Null until the first measured call of a
  // conversation, when the panel falls back to a character estimate.
  const [chatContextUsage, setChatContextUsage] = useState(null);
  const agentResumeEventsRef = useRef([]);
  // Shape the backend's measured usage for the panel. A payload without
  // prompt_tokens carries no measurement, so the panel keeps estimating.
  // `source` says where the number came from: the provider, a local count of the
  // assembled request, or a count of the restored working state for a chat whose
  // last turn predates the persisted measurement. The panel labels them
  // differently instead of presenting all three as the provider's number.
  const contextUsageFromPayload = (payload) => (
    payload && payload.prompt_tokens > 0
      ? {
        promptTokens: payload.prompt_tokens,
        completionTokens: payload.completion_tokens || 0,
        totalTokens: payload.total_tokens || 0,
        contextWindow: payload.context_window || 0,
        source: payload.source || '',
      }
      : null
  );
  const [chatInput, setChatInput] = useState('');
  // Bumped when something outside the chat (e.g. the PDF viewer's "Ask about")
  // drops text into the composer and the caret should land there.
  const [chatInputFocusSignal, setChatInputFocusSignal] = useState(0);
  const [pendingAttachments, setPendingAttachments] = useState([]);
  const [isAgentRunning, setIsAgentRunning] = useState(false);
  // Messages typed while a turn is running, waiting to be handed to it. An entry
  // leaves this list when the backend reports it delivered, when the user
  // cancels it, or when the turn ends without delivering it — in which case it
  // is sent as an ordinary next turn.
  const [queuedMessages, setQueuedMessages] = useState([]);
  const [isInterruptPending, setIsInterruptPending] = useState(false);
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
  const isChatLayout = layoutMode === 'chat' || layoutMode === 'chat-bottom';
  // The studio: editor + preview across the top, chat and terminal side by side
  // beneath, workspace explorer docked left. See utils/studioLayout.js.
  const isStudioLayout = layoutMode === 'studio';
  // The document layout: the open .tex/.md and its own preview (the PDF for
  // LaTeX, the rendered document for Markdown/HTML) across the full width, with
  // neither chat nor terminal on screen. It renders the same EditorPanel as the
  // IDE layout and only seeds the panel's preview flags, so every toolbar
  // toggle keeps working once the user is inside it.
  const isDocumentLayout = layoutMode === 'document';
  // Layouts that show the editor and its preview, and therefore share the IDE
  // layout's docked sidebar and resize handle. See utils/layoutModes.js.
  const isEditorLayout = layoutShowsEditor(layoutMode);
  // The plan layout is entered from a backend event, not from a click, so the
  // layout the user was in has to be read at that moment rather than closed
  // over: the event handler below is not re-created per render. The ref is
  // written by an effect so the state stays the single source of truth.
  const layoutModeRef = useRef(layoutMode);
  useEffect(() => { layoutModeRef.current = layoutMode; }, [layoutMode]);
  const planReturnLayoutRef = useRef('ide');
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
    if (isChatLayout) {
      setIsChatVisible(true);
    }
  }, [isChatLayout]);

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
  const [moveModal, setMoveModal] = useState(null);

  // ── Panel sizing ──────────────────────────────────────────────────────────
  const [sidebarWidth, setSidebarWidth] = useState(330);
  const [chatWidth, setChatWidth] = useState(400);
  const [bottomPanelHeight, setBottomPanelHeight] = useState(240);
  // The studio arranges the same panels in a different geometry, so it keeps
  // its own sizes: sharing them would mean a chat widened for the studio's
  // bottom row also widening the IDE's right-hand dock, and a bottom row sized
  // to hold a conversation reopening as a 700px terminal in the IDE.
  const [studioChatWidth, setStudioChatWidth] = useState(STUDIO_CHAT_WIDTH_DEFAULT);
  const [studioBottomHeight, setStudioBottomHeight] = useState(STUDIO_BOTTOM_HEIGHT_DEFAULT);
  const [isEditorMaximized, setIsEditorMaximized] = useState(false);
  const [isBottomMaximized, setIsBottomMaximized] = useState(false);
  // The studio's whole geometry is this one grid template: the panels below are
  // the IDE's own components kept at their existing positions in the tree — so
  // switching layouts never remounts the editor or tears down a live terminal —
  // and only their CSS placement changes.
  const studioGrid = useMemo(() => studioGridTemplate({
    chatWidth: studioChatWidth,
    bottomHeight: studioBottomHeight,
    isChatVisible,
    isTerminalVisible: !isTerminalCollapsed,
    isEditorMaximized,
    isBottomMaximized,
  }), [studioChatWidth, studioBottomHeight, isChatVisible, isTerminalCollapsed, isEditorMaximized, isBottomMaximized]);

  // ── Modals ─────────────────────────────────────────────────────────────────
  const [showNewProjectModal, setShowNewProjectModal] = useState(false);
  const [importError, setImportError] = useState('');
  const [newProjName, setNewProjName] = useState('');
  const [newProjPath, setNewProjPath] = useState('');
  const [newProjDesc, setNewProjDesc] = useState('');
  // A new project starts with no model configured; the user picks one from the
  // global model store (chat toolbar or Project Settings).
  const [newProjModel, setNewProjModel] = useState('');
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
  // `create_plan` is the only request that carries `markdown_content`, and it
  // is the only one that cannot be answered without reading the project. It
  // goes to the docked PlanPanel; everything else stays a modal.
  const planRequest = confirmRequest?.markdown_content ? confirmRequest : null;
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isHardwareModalOpen, setIsHardwareModalOpen] = useState(false);
  const [isAssetStoreOpen, setIsAssetStoreOpen] = useState(false);
  const [isCloudSyncOpen, setIsCloudSyncOpen] = useState(false);
  const [isCloudDownloadOpen, setIsCloudDownloadOpen] = useState(false);
  // Folder the downloaded project is created in, chosen with the directory
  // picker, which lives here because the picker is a sibling modal.
  const [cloudDownloadParent, setCloudDownloadParent] = useState('');
  // Mirrors the project's cloud status so the activity bar and status bar can
  // show it without either of them polling the backend on its own.
  const [cloudStatus, setCloudStatus] = useState(null);
  // rel path -> synced | pending | syncing | conflict, for the tree badges.
  const [cloudFileStates, setCloudFileStates] = useState(null);
  const [webSearchConfig, setWebSearchConfig] = useState({ enabled: true, mcp_url: '', mcp_tool: 'web_search' });
  const [showInstallPrompt, setShowInstallPrompt] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);

  // ── Global Models ─────────────────────────────────────────────────────────
  // The catalog lives in ModelCatalogProvider so every surface (chat toolbar,
  // project dialogs, Edit Models, onboarding) reads the same list and sees
  // registrations made anywhere else without a reload.
  const {
    models: globalModels,
    refresh: fetchGlobalModels,
    saveModel: saveGlobalModel,
    deleteModel: deleteGlobalModel,
    loadLocalOllamaModels: loadLocalOllamaCatalogModels,
    connections: providerConnections,
    saveConnection: saveProviderConnection,
    deleteConnection: deleteProviderConnection,
  } = useModelCatalog();
  const [showEditModelsModal, setShowEditModelsModal] = useState(false);
  const [showAddModelModal, setShowAddModelModal] = useState(false);
  const [editingModelModalData, setEditingModelModalData] = useState(null);
  const [showEditProvidersModal, setShowEditProvidersModal] = useState(false);
  const [showAddConnectionModal, setShowAddConnectionModal] = useState(false);
  const [editingConnectionModalData, setEditingConnectionModalData] = useState(null);

  // ── IDE settings ──────────────────────────────────────────────────────────
  const [settingsTab, setSettingsTab] = useState('general');
  // Empty until the chat list loads. There is no chat whose id is the literal
  // "main": the default chat is stored as `main_<project>`, so a sentinel here
  // would render a selector value that matches no option while the body showed
  // whatever chat the server fell back to.
  const [activeChatId, setActiveChatId] = useState('');
  const [mainChatId, setMainChatId] = useState('');
  const [chats, setChats] = useState([]);
  // The built-in tutorial lives in a reserved chat (`tutorial_<project>`). Its id and
  // question menu come from the backend so the front-end never has to guess either.
  const [tutorialChatId, setTutorialChatId] = useState('');
  const [tutorialTopics, setTutorialTopics] = useState([]);
  const [theme, setTheme] = useState(() => safeGetLocalStorage('theme', 'dark'));
  // Accessibility interface scale. Unlike the other appearance settings this
  // one lives in ui_settings.json rather than localStorage: it is the setting a
  // user with low vision cannot work around if it silently resets, and the
  // backend store is the one whose stated purpose is surviving restarts.
  const [uiScale, setUiScale] = useState(UI_SCALE_DEFAULT);
  const [editorFontSize, setEditorFontSize] = useState(() => Number(safeGetLocalStorage('editorFontSize', 13)));
  const [editorTabSize, setEditorTabSize] = useState(() => Number(safeGetLocalStorage('editorTabSize', 4)));
  const [editorWordWrap, setEditorWordWrap] = useState(() => safeGetLocalStorage('editorWordWrap', 'on'));
  const [editorMinimap, setEditorMinimap] = useState(() => safeGetLocalStorage('editorMinimap', 'on'));
  const [showHiddenWorkspaceFiles, setShowHiddenWorkspaceFiles] = useState(false);

  // ── Accessibility interface scale ───────────────────────────────────────
  // The factor is published as a CSS custom property on the document element;
  // `.vscode-app` turns it into a `zoom` over the whole interface. Monaco
  // (automaticLayout) and xterm (a ResizeObserver on its container) both see
  // their container change size in the zoomed coordinate space and re-fit on
  // their own, so no manual relayout is needed here.
  useEffect(() => {
    document.documentElement.style.setProperty('--ui-scale', String(uiScale));
  }, [uiScale]);

  // Restore the stored scale on startup (localStorage is not reliable in the
  // webview, so this setting is owned by the backend).
  useEffect(() => {
    fetch('/api/settings/appearance')
      .then(r => r.ok ? r.json() : null)
      .then(cfg => { if (cfg) setUiScale(clampUiScale(cfg.ui_scale)); })
      .catch(() => { });
  }, []);

  // The scale is applied immediately but written back on a trailing delay:
  // dragging the settings slider walks through every step in between, and each
  // one would otherwise rewrite ui_settings.json.
  const uiScaleSaveTimerRef = useRef(null);
  useEffect(() => () => clearTimeout(uiScaleSaveTimerRef.current), []);

  const applyUiScale = useCallback((value) => {
    const next = roundUiScale(value);
    setUiScale(next);
    clearTimeout(uiScaleSaveTimerRef.current);
    uiScaleSaveTimerRef.current = setTimeout(() => {
      fetch('/api/settings/appearance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ui_scale: next }),
      }).catch(() => { });
    }, 300);
    return next;
  }, []);

  useEffect(() => {
    fetch('/api/settings/workspace')
      .then(r => r.ok ? r.json() : null)
      .then(cfg => {
        if (cfg?.show_hidden_workspace_files !== undefined) {
          setShowHiddenWorkspaceFiles(Boolean(cfg.show_hidden_workspace_files));
        }
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
    try {
      const stored = JSON.parse(localStorage.getItem('ephemeralParams')) || {};
      // `think` was a per-run override before thinking became a model-catalog
      // capability. Drop a stored value so it cannot be sent as a request
      // parameter that nothing reads back.
      delete stored.think;
      return stored;
    } catch { return {}; }
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
  const diskFileContentsRef = useRef({});
  const gitStatusRequestRef = useRef(null);
  const lastEditorInputAtRef = useRef(0);
  const importFileInputRef = useRef(null);
  const importTargetPathRef = useRef('');

  // Keep fileContentRef in sync with committed React state. During active
  // Monaco typing it is updated directly from the editor to avoid stale
  // render values overwriting freshly typed text.
  useEffect(() => {
    fileContentRef.current = fileContent;
  }, [fileContent]);

  function getCurrentTextFileContent() {
    if (selectedFile && !isBinaryEditorFile(selectedFile)) {
      const editorValue = editorRef.current?.getModel?.()?.getValue?.();
      if (typeof editorValue === 'string') return editorValue;
    }
    return fileContentRef.current;
  }

  async function refreshSelectedFileFromDiskIfUnmodified() {
    if (!activeProject?.project_path || !selectedFile) return;
    if (isBinaryEditorFile(selectedFile)) return;
    if (editorRef.current?.hasTextFocus?.()) return;
    if (Date.now() - lastEditorInputAtRef.current < 1500) return;
    const lastDiskContent = diskFileContentsRef.current[selectedFile];
    if (lastDiskContent === undefined || fileContentRef.current !== lastDiskContent) return;
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
  const { startResizing } = useResizing({
    setSidebarWidth,
    setChatWidth,
    setBottomPanelHeight,
    sidebarWidth,
    chatWidth,
    bottomPanelHeight,
    studioChatWidth,
    setStudioChatWidth,
    studioBottomHeight,
    setStudioBottomHeight,
  });

  // ── Effects ───────────────────────────────────────────────────────────────
  useEffect(() => {
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
  };

  const handleGlobalModelSave = async (modelData) => {
    try {
      const previousModelId = modelData.previous_id || modelData.id;
      const result = await saveGlobalModel(modelData);
      if (result.ok) {
        const projectUsesMainModel = activeProject?.model === previousModelId || activeProject?.model === modelData.id;
        const projectUsesWorkerModel = activeProject?.worker_model === previousModelId || activeProject?.worker_model === modelData.id;
        if (activeProject && (projectUsesMainModel || projectUsesWorkerModel)) {
          const payload = {
            project_name: activeProject.name,
            chat_id: activeChatId
          };
          if (projectUsesMainModel) {
            payload.model = modelData.id;
          }
          if (projectUsesWorkerModel) {
            payload.worker_model = modelData.id;
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
        setShowAddModelModal(false);
      }
    } catch (e) { console.error(e); }
  };

  const handleConnectionSave = async (connectionData) => {
    const result = await saveProviderConnection(connectionData);
    if (result.ok) {
      setShowAddConnectionModal(false);
    }
    return result;
  };

  const handleConnectionDelete = (connectionId) => deleteProviderConnection(connectionId);

  const handleGlobalModelDelete = (modelId) => deleteGlobalModel(modelId);

  const handleLoadLocalOllamaModels = () => loadLocalOllamaCatalogModels();
  const handleProjectModelChange = async (field, value) => {
    if (!activeProject) return;
    try {
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
        use_shared_memory: activeProject.use_shared_memory,
        chat_id: activeChatId
      };

      // Update specific field (orchestrator or worker)
      if (field === 'model') {
        payload.model = value;
      } else if (field === 'worker_model') {
        payload.worker_model = value;
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
        // The measurement described the previous project's window.
        setChatContextUsage(null);
        setIsLoadingChat(true);

        // Fetch chats
        fetch(`/api/chat/list?project_name=${encodeURIComponent(activeProject.name)}&t=${Date.now()}`)
          .then(res => res.json())
          .then(data => {
            const loadedChats = data.chats || [];
            setChats(loadedChats);
            const projectMainChatId = data.main_chat_id || (loadedChats.length > 0 ? loadedChats[0].id : '');
            setMainChatId(projectMainChatId);
            // Published by the server (empty when the project has no tutorial chat) so
            // the question menu reappears when the tutorial is reopened from the chat
            // sidebar rather than from the ActivityBar button.
            setTutorialChatId(data.tutorial_chat_id || '');

            // Restore the last chat, but only if it still exists. Every candidate
            // is checked against the loaded list: an id the project no longer has
            // (a deleted chat, or a sentinel written by an older build) must not
            // reach the server, which would answer with a different chat's
            // history and leave the selector disagreeing with the transcript.
            const isKnownChat = (id) => !!id && loadedChats.some(c => c.id === id);
            const savedChatId = localStorage.getItem(`lastChat_${activeProject.name}`);
            const currentChatId = [savedChatId, activeProject.current_chat_id, projectMainChatId]
              .find(isKnownChat) || (loadedChats.length > 0 ? loadedChats[0].id : '');
            if (savedChatId !== currentChatId) {
              // Drop the stale pointer so the next reopen does not repeat this.
              if (currentChatId) {
                localStorage.setItem(`lastChat_${activeProject.name}`, currentChatId);
              } else {
                localStorage.removeItem(`lastChat_${activeProject.name}`);
              }
            }
            setActiveChatId(currentChatId);
            if (!activeProject.current_chat_id || activeProject.current_chat_id !== currentChatId) {
              setActiveProject(prev => prev ? { ...prev, current_chat_id: currentChatId } : null);
            }

            // Now fetch history for this chat
            fetch(`/api/chat/history?project_name=${encodeURIComponent(activeProject.name)}&chat_id=${encodeURIComponent(currentChatId)}&t=${Date.now()}`)
              .then(async res => {
                const payload = await res.json();
                if (!res.ok) throw new Error(payload?.error || `history request failed: ${res.status}`);
                // The server names the chat it answered for; anything else would
                // put another conversation under this selector.
                if (payload.chat_id && payload.chat_id !== currentChatId) {
                  throw new Error(`history returned chat ${payload.chat_id}, expected ${currentChatId}`);
                }
                return payload;
              })
              .then(histData => {
                startTransition(() => {
                  // The server still holds the measured window for this chat.
                  setChatContextUsage(contextUsageFromPayload(histData.context_usage));
                  if (histData.history && histData.history.length > 0) {
                    // Restore previous conversation
                    setChatMessages(attachThoughtActivityToMessages(histData.history, histData.activity || []));
                  } else {
                    // First time opening this project/chat → show greeting
                    const greeting = activeProject.project_name || activeProject.name;
                    setChatMessages([{ role: 'assistant', content: t('app.greeting', { projectName: greeting }) }]);
                  }
                  setTerminalLogs(activityToTerminalLogs(histData.activity || []));
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
      setChatContextUsage(null);
      setActiveChatId('');
      setMainChatId('');
      setGitChanges([]);
      setTerminalLogs([]);
      setAchievementsMemory('');
      setCommitMessage('');
      prevProjectNameRef.current = null;
    }
  }, [activeProject]);

  const handleSwitchChat = async (id) => {
    if (!activeProject || !id || id === activeChatId) return;
    setIsLoadingChat(true);
    // Another chat is another history: the measured window no longer applies.
    setChatContextUsage(null);
    setActiveChatId(id);
    setActiveProject(prev => prev ? { ...prev, current_chat_id: id } : null);
    localStorage.setItem(`lastChat_${activeProject.name}`, id);

    setTimeout(async () => {
      try {
        const res = await fetch(`/api/chat/history?project_name=${encodeURIComponent(activeProject.name)}&chat_id=${encodeURIComponent(id)}&t=${Date.now()}`);
        if (res.ok) {
          const data = await res.json();
          if (data.chat_id && data.chat_id !== id) {
            throw new Error(`history returned chat ${data.chat_id}, expected ${id}`);
          }
          const greeting = activeProject.project_name || activeProject.name;
          startTransition(() => {
            setChatContextUsage(contextUsageFromPayload(data.context_usage));
            if (data.history && data.history.length > 0) {
              setChatMessages(attachThoughtActivityToMessages(data.history, data.activity || []));
            } else {
              setChatMessages([{ role: 'assistant', content: t('app.greeting', { projectName: greeting }) }]);
            }
            setTerminalLogs(activityToTerminalLogs(data.activity || []));
          });
        }
      } catch (err) {
        console.error(err);
      } finally {
        setIsLoadingChat(false);
      }
    }, 10);
  };

  const createChatForTask = async (chatName) => {
    if (!activeProject) return null;
    const res = await fetch('/api/chat/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_name: activeProject.name, chat_name: chatName }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || t('app.createChatFailed', 'Failed to create chat'));
    }
    const data = await res.json();
    const chatId = data.id;
    setChats(prev => prev.some(chat => chat.id === chatId) ? prev : [...prev, data]);
    setActiveChatId(chatId);
    setActiveProject(prev => prev ? { ...prev, current_chat_id: chatId } : null);
    localStorage.setItem(`lastChat_${activeProject.name}`, chatId);
    // A brand-new chat has no measured window yet: the previous chat's
    // measurement must not leak into this one's indicator.
    setChatContextUsage(null);
    const greeting = activeProject.project_name || activeProject.name;
    const baseMessages = [{ role: 'assistant', content: t('app.greeting', { projectName: greeting }) }];
    setChatMessages(baseMessages);
    return { chatId, baseMessages };
  };

  // Open (or reopen) the built-in tutorial chat. The backend owns the reserved chat id,
  // the welcome text, and the question menu, so clicking the button twice returns to the
  // same conversation instead of stacking a new welcome on top of it.
  const handleOpenTutorial = async () => {
    if (!activeProject) {
      setAlertMessage(t('tutorial.needProject', 'Open or create a project first — the tutorial runs inside a project chat.'));
      return;
    }
    try {
      const res = await fetch('/api/tutorial/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_name: activeProject.name, lang: i18n.language }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || t('tutorial.openFailed', 'Failed to open the tutorial'));
      }
      const data = await res.json();
      const chatId = data.chat_id;

      setTutorialChatId(chatId);
      setTutorialTopics(data.topics || []);
      setChats(prev => prev.some(c => c.id === chatId) ? prev : [...prev, { id: chatId, name: data.name }]);

      // Another chat is another history: the previous chat's measurement no
      // longer applies, and this one's comes back with its transcript.
      setChatContextUsage(contextUsageFromPayload(data.context_usage));
      setActiveChatId(chatId);
      setActiveProject(prev => prev ? { ...prev, current_chat_id: chatId } : null);
      localStorage.setItem(`lastChat_${activeProject.name}`, chatId);
      setChatMessages(data.history || []);

      if (layoutMode === 'ide') setIsChatVisible(true);
    } catch (err) {
      setAlertMessage(err.message);
    }
  };

  // The menu must also appear when the tutorial chat is reopened from the chat sidebar,
  // where nothing went through /api/tutorial/open and so no topics were returned.
  useEffect(() => {
    if (!tutorialChatId || activeChatId !== tutorialChatId || tutorialTopics.length) return;
    let cancelled = false;
    fetch(`/api/tutorial/topics?lang=${encodeURIComponent(i18n.language || 'en')}`)
      .then(res => res.ok ? res.json() : null)
      .then(data => { if (!cancelled && data?.topics) setTutorialTopics(data.topics); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [tutorialChatId, activeChatId, tutorialTopics.length]);

  // Answer a menu topic. The server appends the question and its pre-written answer from
  // the guide — no agent run — so the tutorial works before any model is registered.
  const handleTutorialTopic = async (topicId) => {
    if (!activeProject) return;
    const res = await fetch('/api/tutorial/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_name: activeProject.name, topic_id: topicId, lang: i18n.language }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || t('tutorial.answerFailed', 'Failed to load the tutorial answer'));
    }
    const data = await res.json();
    setChatMessages(prev => [...prev, ...(data.messages || [])]);
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

  // Chat auto-scroll lives in ChatPanel, which owns the scroll container and
  // only follows new content while the user is parked at the bottom.

  // Global keyboard shortcuts (Ctrl+S, Ctrl+J, Ctrl+/- zoom)
  useEffect(() => {
    // Match the physical key alongside the character. `e.key` is resolved by the
    // platform's keyboard/compose layer, which is not always available in a
    // packaged runtime; `e.code` names the physical key and stays correct there.
    const handleKeyDown = (e) => {
      const isCtrl = e.ctrlKey || e.metaKey;
      if (isCtrl && (e.key === 's' || e.code === 'KeyS')) { e.preventDefault(); saveFileRef.current?.(); }
      else if (isCtrl && (e.key === 'j' || e.code === 'KeyJ')) {
        e.preventDefault();
        if (isBottomMaximized) {
          setIsBottomMaximized(false);
        } else if (isTerminalCollapsed) {
          setIsTerminalCollapsed(false);
        } else {
          setIsTerminalCollapsed(true);
        }
      }
      // Interface scale — Shift distinguishes these from the editor's own
      // Ctrl +/- font size, which stays bound to the focused editor. With Shift
      // held, `e.key` reports the shifted character ('+', '_', ')'), so the
      // physical `e.code` is matched alongside it.
      else if (isCtrl && e.shiftKey && (e.key === '+' || e.key === '=' || e.code === 'Equal' || e.code === 'NumpadAdd')) {
        e.preventDefault();
        applyUiScale(uiScale + UI_SCALE_KEY_STEP);
      }
      else if (isCtrl && e.shiftKey && (e.key === '_' || e.key === '-' || e.code === 'Minus' || e.code === 'NumpadSubtract')) {
        e.preventDefault();
        applyUiScale(uiScale - UI_SCALE_KEY_STEP);
      }
      else if (isCtrl && e.shiftKey && (e.key === ')' || e.key === '0' || e.code === 'Digit0' || e.code === 'Numpad0')) {
        e.preventDefault();
        applyUiScale(UI_SCALE_DEFAULT);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isBottomMaximized, isTerminalCollapsed, uiScale, applyUiScale]);

  useEffect(() => {
    safeSetLocalStorage('theme', theme);
    if (theme === 'light') document.body.classList.add('light-theme');
    else document.body.classList.remove('light-theme');
    // `color-scheme` is declared on :root, so the html element keeps the dark
    // palette (native scrollbars, form controls and the UA selection color)
    // unless it is switched here as well.
    document.documentElement.style.colorScheme = theme === 'light' ? 'light' : 'dark';
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
  // fileContent intentionally excluded: the guard in refreshSelectedFileFromDiskIfUnmodified
  // now reads fileContentRef.current (always current) instead of a closure-captured value,
  // so there is no need to recreate this effect on every keystroke.
  // showHiddenWorkspaceFiles is included so the polling closure's fetchFiles() default
  // parameter always matches the current toggle (otherwise a stale closure would
  // periodically overwrite the file list with the toggle value from when the effect
  // was last created, making hidden files flicker on/off).
  }, [activeProject, useShadowGit, currentGitRootPath, selectedFile, showHiddenWorkspaceFiles]);

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

  // Only the visible conversation is replayed to the agent. Legacy "system" rows
  // (stored [MODE]/achievements audit entries) are never sent: they are not part of
  // the conversation and a mid-history system message breaks chat templates that
  // require the system message to come first.
  const serializeChatHistoryForAgent = (messages, limit = 18) => (
    (messages || [])
      .slice(-limit)
      .filter(msg => msg && (msg.role === 'user' || msg.role === 'assistant'))
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

  const MAX_MERGED_LOG_CHARS = 16000;
  const clampLogMessage = (value) => {
    const text = String(value ?? '');
    if (text.length <= MAX_MERGED_LOG_CHARS) return text;
    return `${text.slice(0, MAX_MERGED_LOG_CHARS)}\n[log truncated]`;
  };

  const normalizeLogAgent = (agent) => String(agent || '').trim().replace(/^@+/, '');
  const sanitizeVisibleStreamChunk = (value) => String(value ?? '').replace(/<\/?think>/gi, '');
  const mergeableLogTypes = new Set(['thought', 'reflection', 'stream_chunk', 'stdout', 'stderr']);
  const thinkingLogTypes = new Set(['thought', 'reflection', 'stream_chunk']);
  const shouldMergeLog = (left, right) => (
    left
    && right
    && left.type === right.type
    && mergeableLogTypes.has(left.type)
    && normalizeLogAgent(left.agent) === normalizeLogAgent(right.agent)
  );
  const joinMergedLogMessage = (leftMessage, rightMessage, type) => {
    const left = String(leftMessage ?? '');
    const right = String(rightMessage ?? '');
    if (!left || !right) return left + right;
    if (type === 'thought') {
      return left + right;
    }
    if (type === 'reflection') {
      return `${left.replace(/\s+$/g, '')}\n${right.replace(/^\s+/g, '')}`;
    }
    return left + right;
  };
  const mergeLogEntries = (logs) => (
    (logs || []).reduce((merged, log) => {
      if (!log) return merged;
      const cleanLog = {
        ...log,
        agent: normalizeLogAgent(log.agent),
        message: clampLogMessage(log.message),
      };
      const last = merged[merged.length - 1];
      if (shouldMergeLog(last, cleanLog)) {
        merged[merged.length - 1] = {
          ...last,
          message: clampLogMessage(joinMergedLogMessage(last.message, cleanLog.message, cleanLog.type)),
        };
        return merged;
      }
      merged.push(cleanLog);
      return merged;
    }, [])
  );

  const activityToTerminalLogs = (activity = []) => (
    mergeLogEntries((activity || [])
      .filter(item => item && ['thought', 'reflection', 'stream_chunk'].includes(item.event))
      .map(item => ({
        type: item.event,
        message: item.event === 'stream_chunk'
          ? sanitizeVisibleStreamChunk(item.content || item.payload?.content || '')
          : clampLogMessage(item.content || item.payload?.content || ''),
        agent: normalizeLogAgent(item.agent || item.payload?.agent || ''),
        timestamp: item.timestamp
          ? new Date(item.timestamp).toLocaleTimeString()
          : new Date().toLocaleTimeString(),
      }))
      .filter(item => item.message)
    )
  );

  const activityTimestampMs = (value) => {
    const ms = Date.parse(value || '');
    return Number.isFinite(ms) ? ms : null;
  };

  // Agent errors are stored as activity, not as chat messages: the model must never
  // read its own failures back as conversation. They are re-inserted here, in
  // timestamp order, so a failed turn still shows its error bubble after a reload.
  const mergeErrorActivityIntoMessages = (messages = [], activity = []) => {
    const errors = (activity || [])
      .filter(item => item?.event === 'error' && String(item.content || item.payload?.message || '').trim())
      .map(item => ({
        role: 'assistant',
        content: t('app.agentError', '🔴 Erro do Agente: {{message}}', {
          message: String(item.content || item.payload?.message || ''),
        }),
        is_error: true,
        timestamp: item.timestamp,
        _fromActivity: true,
      }));
    if (!errors.length) return messages;

    const merged = [...messages, ...errors];
    merged.sort((left, right) => {
      const leftTime = activityTimestampMs(left.timestamp);
      const rightTime = activityTimestampMs(right.timestamp);
      if (leftTime === null || rightTime === null || leftTime === rightTime) return 0;
      return leftTime - rightTime;
    });
    return merged;
  };

  const attachThoughtActivityToMessages = (history = [], activity = []) => {
    const messages = (history || []).map(message => ({ ...message }));
    const thoughts = (activity || [])
      .filter(item => item?.event === 'thought' && String(item.content || item.payload?.content || '').trim())
      .map(item => ({
        timestampMs: activityTimestampMs(item.timestamp),
        content: String(item.content || item.payload?.content || ''),
      }));

    if (!messages.length || !thoughts.length) return mergeErrorActivityIntoMessages(messages, activity);

    let thoughtIndex = 0;
    let pendingThoughts = [];
    for (const message of messages) {
      const messageTime = activityTimestampMs(message.timestamp);
      while (
        thoughtIndex < thoughts.length
        && (messageTime === null || thoughts[thoughtIndex].timestampMs === null || thoughts[thoughtIndex].timestampMs <= messageTime)
      ) {
        pendingThoughts.push(thoughts[thoughtIndex].content);
        thoughtIndex += 1;
      }
      if (message.role === 'assistant' && pendingThoughts.length) {
        message._thoughtStream = pendingThoughts.join('');
        pendingThoughts = [];
      }
    }

    while (thoughtIndex < thoughts.length) {
      pendingThoughts.push(thoughts[thoughtIndex].content);
      thoughtIndex += 1;
    }
    if (pendingThoughts.length) {
      const lastAssistant = [...messages].reverse().find(message => message.role === 'assistant');
      if (lastAssistant) {
        lastAssistant._thoughtStream = `${lastAssistant._thoughtStream || ''}${pendingThoughts.join('')}`;
      }
    }

    return mergeErrorActivityIntoMessages(messages, activity);
  };

  const addLog = (type, message, agent) =>
    setTerminalLogs(prev => {
      const cleanMessage = type === 'stream_chunk'
        ? sanitizeVisibleStreamChunk(message)
        : String(message ?? '');
      if (!cleanMessage) return prev;
      const cleanAgent = normalizeLogAgent(agent);
      let next;
      if (mergeableLogTypes.has(type)) {
        const candidate = { type, agent: cleanAgent };
        for (let index = prev.length - 1; index >= 0; index -= 1) {
          const existing = prev[index];
          if (shouldMergeLog(existing, candidate)) {
            next = [...prev];
            next[index] = {
              ...existing,
              agent: normalizeLogAgent(existing.agent),
              message: clampLogMessage(joinMergedLogMessage(existing.message, cleanMessage, type)),
            };
            break;
          }
          if (
            thinkingLogTypes.has(type)
            && thinkingLogTypes.has(existing.type)
            && !shouldMergeLog(existing, candidate)
          ) {
            break;
          }
        }
      }
      if (!next) next = [...prev, { type, message: clampLogMessage(cleanMessage), agent: cleanAgent, timestamp: new Date().toLocaleTimeString() }];
      return trimToLimit(next, panelMaxLines);
    });

  const addProblem = ({ tool = t('app.agentTool', 'Agent'), message, severity = 'error', ...metadata }) => {
    if (!message) return;
    setProblems(prev => trimToLimit([
      ...prev,
      {
        id: Math.random().toString(),
        tool,
        message,
        severity,
        timestamp: new Date().toLocaleTimeString(),
        ...metadata,
      },
    ], panelMaxLines));
  };

  // Sub-folders with their own .git are gitlinks for the shadow repository, so
  // agent edits inside them never produce a turn checkpoint and the Review panel
  // stays empty for work that really happened. Said once per project path when
  // the project is opened, instead of leaving the gap silent.
  const warnedNestedReposRef = useRef(new Set());
  useEffect(() => {
    const projectPath = activeProject?.project_path;
    if (!projectPath || warnedNestedReposRef.current.has(projectPath)) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/git/nested-repos?${new URLSearchParams({ projectPath })}`);
        if (!res.ok) return;
        const data = await res.json();
        const nested = data.nested_repos || [];
        if (cancelled || nested.length === 0) return;
        warnedNestedReposRef.current.add(projectPath);
        addLog('warning', t('app.shadowGitNestedRepos', { paths: nested.join(', ') }));
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [activeProject?.project_path]);

  const compactForLatexFixPrompt = (value, limit) => {
    const text = String(value || '');
    if (text.length <= limit) return text;
    return `${text.slice(0, limit)}\n[truncated ${text.length - limit} characters]`;
  };

  const summarizeCompileTarget = (compileDebug = {}) => {
    const target = compileDebug.selected_main_rel || compileDebug.selected_main_file || '';
    const input = compileDebug.compiler_input_tex || '';
    const cwd = compileDebug.compiler_cwd || '';
    const returncode = compileDebug.compiler_returncode;
    return [
      target ? `Selected main file: ${target}` : '',
      input ? `Compiler input: ${input}` : '',
      cwd ? `Compiler working directory: ${cwd}` : '',
      returncode !== undefined && returncode !== '' ? `Compiler return code: ${returncode}` : '',
    ].filter(Boolean).join('\n');
  };

  const buildLatexFixPrompt = (problem) => {
    const filePath = problem.filePath || selectedFile || '';
    const compiledMainFile = problem.compiledMainFile || activeProject?.main_file || '';
    const compileDebug = problem.compileDebug || {};
    const compileTarget = summarizeCompileTarget(compileDebug);
    const articleContent = problem.fileContent ?? fileContent ?? '';
    const log = problem.log || problem.message || '';
    const compileMode = problem.partial ? 'partial compilation' : 'full compilation';
    const draftMode = problem.draft ? 'draft mode enabled' : 'draft mode disabled';

    return [
      'Task: Fix the LaTeX compilation error in this OpalaTex project.',
      '',
      'Use the chat_orchestrator workflow: diagnose the compiler error, inspect project files when needed, edit the relevant file(s) with the available tools, and finish with a concise summary of what changed.',
      'Do not guess silently. If the log points to a different file than the selected file, prioritize the compiler location and read that file before editing.',
      '',
      'Project context:',
      `- Project: ${activeProject?.project_name || activeProject?.name || problem.projectName || '(unknown)'}`,
      `- Project path: ${activeProject?.project_path || problem.projectPath || ''}`,
      `- Selected article/file: ${filePath || '(none)'}`,
      `- Configured main file: ${activeProject?.main_file || problem.mainFile || '(none)'}`,
      `- Compiled main file: ${compiledMainFile || '(unresolved)'}`,
      `- Mode: ${compileMode}; ${draftMode}`,
      compileTarget ? `\nCompiler target details:\n${compileTarget}` : '',
      '',
      'Compiler error log:',
      '````text',
      compactForLatexFixPrompt(log, 20000),
      '````',
      '',
      'Selected article/file content at the time of compilation:',
      '````latex',
      compactForLatexFixPrompt(articleContent, 60000),
      '````',
      '',
      'Please correct the project files based on the error above. After editing, explain which file(s) changed and whether the user should compile again.',
    ].filter(part => part !== '').join('\n');
  };

  const buildLatexFixDisplayText = (problem) => {
    const log = problem?.log || problem?.message || t('app.latexCompileFailed', 'LaTeX compilation failed.');
    const filePath = problem?.filePath || selectedFile || '';
    const compiledMainFile = problem?.compiledMainFile || activeProject?.main_file || problem?.mainFile || '';
    return [
      t('app.fixLatexDisplayPrompt', 'Fix LaTeX compilation error'),
      '',
      filePath ? `${t('app.selectedFileLabel', 'Selected file')}: ${filePath}` : '',
      compiledMainFile ? `${t('app.compiledMainFileLabel', 'Compiled main file')}: ${compiledMainFile}` : '',
      '',
      `${t('app.compilerErrorLogLabel', 'Compiler error log')}:`,
      '```text',
      compactForLatexFixPrompt(log, 4000),
      '```',
    ].filter(part => part !== '').join('\n');
  };

  const handleLatexCompileSuccess = () => {
    setProblems(prev => prev.filter(problem => problem.source !== 'latex_compile'));
  };

  const handleLatexCompileError = (details) => {
    setProblems(prev => prev.filter(problem => problem.source !== 'latex_compile'));
    addProblem({
      tool: t('app.latexCompilerTool', 'LaTeX compiler'),
      message: details.log || t('app.latexCompileFailed', 'LaTeX compilation failed.'),
      severity: 'error',
      source: 'latex_compile',
      filePath: details.filePath || '',
      fileContent: details.fileContent || '',
      projectPath: details.projectPath || '',
      projectName: details.projectName || '',
      mainFile: details.mainFile || '',
      compiledMainFile: details.compiledMainFile || '',
      log: details.log || '',
      compileDebug: details.compileDebug || {},
      partial: Boolean(details.partial),
      draft: Boolean(details.draft),
    });
  };

  // ── API calls ─────────────────────────────────────────────────────────────
  const fetchProjects = async (forceSelectName) => {
    try {
      const res = await fetch('/api/opalatex/list-projects');
      if (res.ok) {
        const data = await res.json();
        setProjects(data.projects || []);
        if (data.projects?.length > 0) {
          if (forceSelectName) {
            const forced = data.projects.find(p => p.name === forceSelectName && p.exists);
            if (forced) { handleSelectProject(forced); return; }
          }
          if (!activeProject) {
            const lastActiveProjectName = localStorage.getItem('lastActiveProject');
            let projToSelect = null;
            if (lastActiveProjectName) {
              projToSelect = data.projects.find(p => p.name === lastActiveProjectName && p.exists);
            }
            if (!projToSelect) {
              projToSelect = data.projects.find(p => p.exists);
            }
            if (projToSelect) handleSelectProject(projToSelect);
          }
        }
      }
    } catch (err) { addLog('error', t('app.failedToLoadProjects', { error: err.message })); }
  };

  const fetchFiles = async (showHiddenOverride = showHiddenWorkspaceFiles) => {
    if (!activeProject) return;
    try {
      const res = await fetch(`/api/files?projectPath=${encodeURIComponent(activeProject.project_path)}&showHiddenFiles=${showHiddenOverride ? 'true' : 'false'}`);
      if (res.ok) { const data = await res.json(); setFiles(data.files || []); }
      else { const e = await res.json(); addLog('error', t('app.failedToListFiles', { error: e.error })); }
    } catch (err) { addLog('error', t('app.fileCallError', { error: err.message })); }
  };

  const handleShowHiddenWorkspaceFilesChange = (checked) => {
    setShowHiddenWorkspaceFiles(checked);
    fetch('/api/settings/workspace', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ show_hidden_workspace_files: checked }),
    }).catch(() => { });
    fetchFiles(checked);
  };

  useEffect(() => {
    if (activeProject) fetchFiles(showHiddenWorkspaceFiles);
  }, [showHiddenWorkspaceFiles]);

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
    if (gitStatusRequestRef.current) return gitStatusRequestRef.current;

    const request = (async () => {
      try {
        const res = await fetch(`/api/git/status?${gitQuerySuffix()}&t=${Date.now()}`);
        if (res.ok) {
          const data = await res.json();
          setGitChanges(data.files || []);
        }
      } catch (err) {
        console.error('Failed to fetch git status', err);
      } finally {
        gitStatusRequestRef.current = null;
      }
    })();
    gitStatusRequestRef.current = request;
    return request;
  };

  // Anything that writes into the project from outside the editor (an Asset
  // Store install, for one) has to re-read the workspace right away: otherwise
  // the new files only show up on the next polling tick, seconds later.
  const refreshWorkspaceFiles = async () => {
    await Promise.all([fetchFiles(), fetchGitStatus()]);
  };

  // Cloud sync status for the active project. Fetching it is also what
  // registers the project with the backend's sync scheduler, so this runs
  // whenever a project becomes active — not only when the panel is open.
  const refreshCloudStatus = useCallback(async () => {
    if (!activeProject?.project_path) { setCloudStatus(null); return; }
    try {
      const params = new URLSearchParams({
        projectPath: activeProject.project_path,
        project: activeProject.name || '',
      });
      const res = await fetch(`/api/cloud/status?${params}`);
      const payload = await res.json();
      setCloudStatus(payload.error ? null : payload);
    } catch (_) {
      setCloudStatus(null);
    }
  }, [activeProject?.project_path, activeProject?.name]);

  // Which files are synced, waiting, moving or conflicted — the explorer marks
  // each one, the way a desktop Drive client does.
  const refreshCloudFileStates = useCallback(async () => {
    if (!activeProject?.project_path) { setCloudFileStates(null); return; }
    try {
      const params = new URLSearchParams({ projectPath: activeProject.project_path });
      const res = await fetch(`/api/cloud/file-states?${params}`);
      const payload = await res.json();
      setCloudFileStates(payload?.enabled ? payload.states : null);
    } catch (_) {
      setCloudFileStates(null);
    }
  }, [activeProject?.project_path]);

  useEffect(() => { refreshCloudStatus(); }, [refreshCloudStatus]);

  const cloudPassRunning = !!cloudStatus?.syncing || !!cloudStatus?.progress?.active;

  useEffect(() => {
    // A background pass finishes without telling the front-end, so the status
    // line is refreshed on a tick. Polling only while sync is on keeps a
    // project that never uses the feature from paying for it. While a pass is
    // actually running the tick speeds up: that is when the footer is showing
    // which file is moving, and a 20 s refresh would make it a slideshow.
    if (!cloudStatus?.settings?.enabled) { setCloudFileStates(null); return undefined; }
    const tick = () => { refreshCloudStatus(); refreshCloudFileStates(); };
    tick();
    const timer = setInterval(tick, cloudPassRunning ? 1000 : 20000);
    return () => clearInterval(timer);
  }, [cloudStatus?.settings?.enabled, cloudPassRunning, refreshCloudStatus, refreshCloudFileStates]);

  const handleSelectProject = (proj) => {
    if (proj.exists === false) {
      addLog('error', t('app.projectDirMissing', { path: proj.project_path }));
      return;
    }

    let currentContents = { ...fileContents };
    if (selectedFile) {
      currentContents[selectedFile] = fileContent;
    }

    const dirtyFiles = openFiles.filter((filePath) => {
      if (isBinaryEditorFile(filePath)) return false;
      const currentContent = currentContents[filePath];
      const diskContent = diskFileContentsRef.current[filePath];
      return currentContent !== undefined && diskContent !== undefined && currentContent !== diskContent;
    });

    if (dirtyFiles.length > 0) {
      setConfirmRequest({
        prompt: t('app.unsavedProjectSwitchPrompt', { count: dirtyFiles.length }),
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
          localStorage.setItem('lastActiveProject', proj.name);
          addLog('info', t('app.projectSelected', { name: proj.project_name || proj.name }));
        }
      });
      return;
    }

    setActiveProject(proj);
    localStorage.setItem('lastActiveProject', proj.name);
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

  const handleStageAllFiles = async () => {
    if (!activeProject) return false;
    try {
      const res = await fetch('/api/git/stage', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(gitRequestPayload({ filePath: '__all__', action: 'stage' })),
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

  // Opening a file has to put the editor on screen, but only the layouts that
  // hide it need leaving: forcing 'ide' from the studio or the document layout
  // would drop the user out of a layout that is already showing the file they
  // just picked.
  const revealEditorLayout = useCallback(() => {
    setLayoutMode(layoutAfterOpeningFile);
  }, []);

  const handleFileSelect = async (filePath, jumpLine = null) => {
    if (!activeProject) return;
    setIsBottomMaximized(false);
    if (selectedFile) {
      const currentContent = getCurrentTextFileContent();
      setFileContents(prev => ({ ...prev, [selectedFile]: currentContent }));
      fileContentRef.current = currentContent;
    }
    if (isUnsupportedSystemFile(filePath)) {
      handleOpenInSystem(filePath);
      addLog('info', t('app.openedInSystemApp', { path: filePath }));
      return;
    }
    if (isBinaryEditorFile(filePath)) {
      setOpenFiles(prev => {
        const deduped = dedupeOpenFileList(prev, filePath);
        return deduped.some(openFile => sameFilePath(openFile, filePath))
          ? deduped.map(openFile => sameFilePath(openFile, filePath) ? filePath : openFile)
          : [...deduped, filePath];
      });
      setFileContent('');
      setSelectedFile(filePath);
      revealEditorLayout();
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
      if (diskFileContentsRef.current[cachedFilePath] !== undefined) {
        diskFileContentsRef.current[filePath] = diskFileContentsRef.current[cachedFilePath];
      }
      setOriginalFileContents(prev => (
        prev[cachedFilePath] === undefined ? prev : { ...prev, [filePath]: prev[cachedFilePath] }
      ));
    }
    if (fileContents[cachedFilePath] !== undefined) {
      setFileContent(fileContents[cachedFilePath]);
      setSelectedFile(filePath);
      revealEditorLayout(); // Put the editor on screen if the layout hides it
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
        revealEditorLayout(); // Put the editor on screen if the layout hides it
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
        revealEditorLayout();
      }
    } catch (err) {
      addLog('error', t('app.readError', { error: err.message }));
      setSelectedFile(filePath);
      setFileContent('');
      revealEditorLayout();
    }
  };

  const saveFile = async ({ suppressCompile = false } = {}) => {
    if (!activeProject || !selectedFile) return false;
    // The PDF panel is a read-only viewer: there is nothing to write back.
    if (isBinaryEditorFile(selectedFile)) return false;
    const currentContent = getCurrentTextFileContent();
    fileContentRef.current = currentContent;
    if (currentContent !== fileContent) {
      setFileContent(currentContent);
    }
    const savedDiskContent = diskFileContentsRef.current[selectedFile];
    if (typeof savedDiskContent === 'string' && savedDiskContent === currentContent) {
      setFileContents(prev => (
        prev[selectedFile] === currentContent ? prev : { ...prev, [selectedFile]: currentContent }
      ));
      return true;
    }
    setIsSaving(true);
    try {
      const res = await fetch('/api/file/write', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath: activeProject.project_path, filePath: selectedFile, content: currentContent }),
      });
      if (res.ok) {
        addLog('info', t('app.fileSaved', { path: selectedFile }));
        diskFileContentsRef.current[selectedFile] = currentContent;
        setFileContents(prev => ({ ...prev, [selectedFile]: currentContent }));

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
    if (sameFilePath(selectedFile, filePath)) {
      const currentContent = getCurrentTextFileContent();
      fileContentRef.current = currentContent;
      setFileContents(prev => ({ ...prev, [filePath]: currentContent }));
    }
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

  // Keeps only `filePath` open. When it is not the active tab we go through
  // handleFileSelect first, so its content is loaded/persisted exactly like a
  // regular tab switch before the other tabs disappear.
  const handleCloseOtherTabs = async (filePath) => {
    if (!sameFilePath(selectedFile, filePath)) {
      await handleFileSelect(filePath);
    } else {
      const currentContent = getCurrentTextFileContent();
      fileContentRef.current = currentContent;
      setFileContents(prev => ({ ...prev, [filePath]: currentContent }));
    }
    setOpenFiles(prev => prev.filter(f => sameFilePath(f, filePath)));
  };

  const handleCloseAllTabs = () => {
    if (selectedFile) {
      const currentContent = getCurrentTextFileContent();
      fileContentRef.current = currentContent;
      setFileContents(prev => ({ ...prev, [selectedFile]: currentContent }));
    }
    setOpenFiles([]);
    setSelectedFile(null);
    setFileContent('');
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
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (!files.length || !activeProject) return;

    const targetDir = importTargetPathRef.current || '';
    let lastImportedPath = null;

    for (const file of files) {
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
        if (data.filePath) lastImportedPath = data.filePath;
      } catch (err) {
        addLog('error', t('app.importFileError', { error: err.message }));
      }
    }

    await fetchFiles();
    if (lastImportedPath) await handleFileSelect(lastImportedPath);
  };

  const handleRenameNode = (node) => {
    if (!activeProject || !node) return;
    setRenamingNodePath(node.path);
  };

  const executeRenameNode = async (node, newPath) => {
    setRenamingNodePath(null);
    if (!activeProject || !node || !newPath || newPath === node.path) return;
    try {
      const res = await fetch('/api/file/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath: activeProject.project_path, oldPath: node.path, newPath })
      });
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
      } else {
        const e = await res.json();
        addLog('error', t('app.fileRenameError', { error: e.error }));
      }
    } catch (err) {
      addLog('error', t('app.renameError', { error: err.message }));
    }
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

  // Moves one or more nodes (files/directories) into targetDirPath ('' = project root).
  const handleMoveNode = async (paths, targetDirPath) => {
    if (!activeProject || !paths || paths.length === 0) return;
    const uniquePaths = Array.from(new Set(paths));
    let successCount = 0;
    for (const oldPath of uniquePaths) {
      const nodeName = oldPath.replace(/\\/g, '/').split('/').pop();
      const newPath = targetDirPath ? `${targetDirPath}/${nodeName}` : nodeName;
      if (sameFilePath(oldPath, newPath)) continue;
      if (isFileInsidePath(targetDirPath || '', oldPath)) { addLog('error', t('app.moveDirectoryIntoItself')); continue; }
      try {
        const res = await fetch('/api/file/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectPath: activeProject.project_path, oldPath, newPath }) });
        if (res.ok) {
          successCount++;
          setOpenFiles(prev => dedupeOpenFileList(prev.map(f => isFileInsidePath(f, oldPath) ? replaceFilePathPrefix(f, oldPath, newPath) : f), newPath));
          setFileContents(prev => { const n = {}; for (const [k, v] of Object.entries(prev)) n[isFileInsidePath(k, oldPath) ? replaceFilePathPrefix(k, oldPath, newPath) : k] = v; return n; });
          setOriginalFileContents(prev => { const n = {}; for (const [k, v] of Object.entries(prev)) n[isFileInsidePath(k, oldPath) ? replaceFilePathPrefix(k, oldPath, newPath) : k] = v; return n; });
          if (isFileInsidePath(selectedFile, oldPath)) setSelectedFile(prev => replaceFilePathPrefix(prev, oldPath, newPath));
        } else {
          const e = await res.json();
          addLog('error', t('app.movePathFailed', { path: oldPath, error: e.error }));
        }
      } catch (err) { addLog('error', t('app.moveError', { error: err.message })); }
    }
    if (successCount > 0) {
      addLog('info', t('app.itemsMoved', { count: successCount }));
      setSelectedNodes(new Set());
      await fetchFiles();
    }
  };

  const handleOpenMoveModal = (node) => {
    setContextMenu(null);
    if (!activeProject || !node) return;
    const paths = (selectedNodes && selectedNodes.has(node.path) && selectedNodes.size > 1)
      ? Array.from(selectedNodes)
      : [node.path];
    setMoveModal({ paths });
  };

  const confirmMoveModal = async (targetDirPath) => {
    if (!moveModal) return;
    const paths = moveModal.paths;
    setMoveModal(null);
    await handleMoveNode(paths, targetDirPath);
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
      const res = await fetch('/api/opalatex/create-project', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_name: newProjName, project_path: finalProjectPath, description: newProjDesc, model: newProjModel, worker_model: newProjWorkerModel, mode: newProjMode, model_params: Object.keys(newProjModelParams).length ? newProjModelParams : undefined, worker_model_params: Object.keys(newProjWorkerModelParams).length ? newProjWorkerModelParams : undefined }),
      });
      if (res.ok) {
        const created = await res.json();
        addLog('info', t('app.projectRegistered', { name: newProjName }));
        setShowNewProjectModal(false); setNewProjName(''); setNewProjPath(''); setNewProjDesc(''); setNewProjModel(''); setNewProjWorkerModel(''); setNewProjApiKey(''); setNewProjApiBase('http://localhost:11434/v1'); setNewProjWorkerApiKey(''); setNewProjWorkerApiBase(''); setNewProjModelParams({}); setNewProjWorkerModelParams({});
        fetchProjects(created.name);
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
    const newState = { name: fresh.name, project_name: fresh.project_name || fresh.name, project_path: fresh.project_path || '', main_file: fresh.main_file || '', git_root_path: fresh.git_root_path || '', compile_on_save_partial: compileOnSavePartial, compile_on_save_full: compileOnSaveFull, model: fresh.model || '', worker_model: fresh.worker_model || '', mode: fresh.mode || 'auto', description: fresh.description || '', model_params: fresh.model_params || {}, worker_model_params: fresh.worker_model_params || {}, api_key: fresh.api_key || '', api_base: fresh.api_base || '', worker_api_key: fresh.worker_api_key || '', worker_api_base: fresh.worker_api_base || '', use_shared_memory: fresh.use_shared_memory ?? false };
    setEditingProject(newState);
  };

  const handleUpdateProject = async (e) => {
    e.preventDefault();
    if (!editingProject) return;
    setEditProjError('');

    try {
      const res = await fetch('/api/opalatex/update-project', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_name: editingProject.name, display_name: editingProject.project_name, project_path: editingProject.project_path, main_file: editingProject.main_file, git_root_path: editingProject.git_root_path || '', compile_on_save_partial: editingProject.compile_on_save_partial === true && editingProject.compile_on_save_full !== true, compile_on_save_full: editingProject.compile_on_save_full === true, model: editingProject.model, worker_model: editingProject.worker_model, mode: editingProject.mode, description: editingProject.description, model_params: editingProject.model_params, worker_model_params: editingProject.worker_model_params, use_shared_memory: editingProject.use_shared_memory, chat_id: activeChatId }),
      });
      if (res.ok) {
        const updated = await res.json();
        addLog('info', t('app.projectUpdated', { name: updated.project_name }));
        // The saved git root was kept as stored but no longer resolves on this
        // machine; the save is not blocked, so say so instead of failing silently.
        if (updated.git_root_warning) addLog('warning', t('app.gitRootStale', { path: updated.git_root_path }));
        setEditingProject(null);
        // Auto-selects the project once its path is fixed, so repairing a
        // project whose folder had moved (e.g. after switching OS) takes effect immediately.
        await fetchProjects(updated.name);
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

  // Cloud download: opening the panel resolves a sensible default parent folder
  // so the common case is "press Download", not "go find the home directory".
  const openCloudDownload = async () => {
    setIsCloudDownloadOpen(true);
    if (cloudDownloadParent) return;
    try {
      const res = await fetch('/api/fs/dirs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: '~' })
      });
      const data = await res.json();
      if (data.current) setCloudDownloadParent(data.current);
    } catch (e) { /* the user can still pick a folder by hand */ }
  };

  const handleProjectDownloaded = (project) => {
    setIsCloudDownloadOpen(false);
    const downloaded = (project?.report?.downloaded || []).length;
    addLog('info', t('app.projectDownloaded', {
      name: project.project_name || project.name,
      count: downloaded,
      defaultValue: '{{name}} downloaded from the cloud ({{count}} file(s)).',
    }));
    fetchProjects(project.name);
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
    else if (dirPicker.target === 'cloud-download') {
      setCloudDownloadParent(dirPicker.current);
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
          fetchProjects(data.name);
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
    setContextMenu(viewportPointToApp(e.clientX, e.clientY));
  };

  const handleNodeContextMenu = (e, node) => {
    if (!activeProject) return;
    e.preventDefault(); e.stopPropagation();
    setRightClickedNode(node);
    setContextMenu(viewportPointToApp(e.clientX, e.clientY));
  };

  const handleOpenInSystem = async (node) => {
    setContextMenu(null);
    if (!activeProject || !node) return;
    const targetPath = typeof node === 'string' ? node : (node.path || node);
    try {
      await fetch('/api/file/open-explorer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath: activeProject.project_path, filePath: targetPath })
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
    if (isInterruptPending) return;
    setIsInterruptPending(true);
    try {
      const res = await fetch('/api/opalatex/interrupt', { method: 'POST' });
      if (res.ok) {
        addLog('info', t('app.interruptSent'));
        setConfirmRequest(null);
      } else {
        addLog('error', t('app.interruptFailed'));
        setIsInterruptPending(false);
      }
    } catch (err) {
      addLog('error', t('app.interruptError', { error: err.message }));
      setIsInterruptPending(false);
    }
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
      case 'token_usage':
        // prompt_tokens is the size of the request the provider just billed, so
        // it already accounts for the system prompt, the tool schemas, the tool
        // calls and the tool results — none of which reach chatMessages.
        setChatContextUsage(prev => contextUsageFromPayload(data) || prev);
        break;
      case 'stream_retract': {
        // An orphan </think> proved this text was reasoning, not the answer, after
        // it had already been streamed. It arrives again as a 'thought' event, so
        // it only has to leave the live response here. The Output log keeps the
        // raw provider stream on purpose.
        const retracted = sanitizeVisibleStreamChunk(data.content);
        if (!retracted) break;
        setChatResponseStream(prev => {
          const next = prev.endsWith(retracted) ? prev.slice(0, -retracted.length) : '';
          chatResponseStreamRef.current = next;
          return next;
        });
        break;
      }
      case 'stream_chunk':
        const visibleStreamChunk = sanitizeVisibleStreamChunk(data.content);
        addLog('stream_chunk', visibleStreamChunk, data.agent);
        if (!visibleStreamChunk) break;
        setChatResponseStream(prev => {
          const next = prev + visibleStreamChunk;
          chatResponseStreamRef.current = next;
          return next;
        });
        break;
      case 'cancelled': {
        addLog('warning', data.message || t('app.executionCancelled'), data.agent);
        chatThoughtStreamRef.current = '';
        setChatThoughtStream('');
        chatResponseStreamRef.current = '';
        setChatResponseStream('');
        setChatMessages(prev => [...prev, {
          role: 'assistant',
          content: '[INTERRUPTED] The user interrupted the agent execution.',
          timestamp: new Date().toISOString(),
        }]);
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
        const finalThoughtStream = chatThoughtStreamRef.current;
        const responseText = (data.response && data.response.trim() !== '')
          ? data.response
          : "⚠️ *O agente concluiu o processamento, mas não emitiu nenhuma resposta textual ou chamada de ferramenta. Isso geralmente acontece quando o modelo de IA sofre uma falha de geração (ex: esqueceu de usar o formato correto após pensar).*";

        chatThoughtStreamRef.current = '';
        setChatThoughtStream('');
        chatResponseStreamRef.current = '';
        setChatResponseStream('');

        setChatMessages(prev => {
          const last = prev[prev.length - 1];
          const baseContent = responseText;
          const finalContent = baseContent;
          if (last?.role === 'assistant' && last.content === finalContent) return prev;
          return [...prev, {
            id: data.message_id,
            role: 'assistant',
            content: finalContent,
            _thoughtStream: finalThoughtStream || undefined,
            timestamp: new Date().toISOString(),
            chat_id: activeChatId,
          }];
        });

        // ── Auto-replace: if there is a pending inline selection range, extract
        //    the first fenced code block from the response and apply it.
        if (pendingInlineRangeRef.current && editorRef.current && monacoRef.current) {
          const range = pendingInlineRangeRef.current;
          pendingInlineRangeRef.current = null;
          try {
            const newCode = extractInlineReplacementBlock(data.response);
            if (newCode !== null) {
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
      case 'user_message_saved':
        // Stamp the stored id on the optimistic user message so editing, retrying
        // and branching have a stable anchor during this session.
        setChatMessages(prev => prev.map(msg => (
          msg.role === 'user'
            && msg.client_message_id === data.client_message_id
            && msg.id === undefined
            ? { ...msg, id: data.message_id }
            : msg
        )));
        break;
      case 'user_message_delivered':
        // The agent has taken the message off the queue and read it. This is the
        // one moment the user is waiting to see, so it is reported as its own
        // state rather than by dropping the waiting badge.
        setQueuedMessages(prev => prev.filter(m => m.clientMessageId !== data.client_message_id));
        setChatMessages(prev => prev.map(msg => (
          msg.client_message_id === data.client_message_id
            ? { ...msg, _deliveryState: 'delivered' }
            : msg
        )));
        addLog('info', t('app.messageDelivered', 'Message delivered to the running agent.'));
        break;
      case 'user_message_backlog':
        // Reported, not acted on here: these entries are still in queuedMessages
        // and the flush effect sends them as the next turn.
        addLog('info', t('app.messageBacklog', 'The turn ended before {{count}} queued message(s) were delivered. Sending them as a new turn.', { count: (data.items || []).length }));
        break;
      case 'agent_finished': addLog('info', t('app.processingCompleted', 'Processamento concluído.')); break;
      case 'input_request':
        setConfirmRequest({ ...data, id: data.id, prompt: data.prompt, options: data.options || ['yes', 'no'], default: data.default || 'yes', type: data.type || 'confirm' });
        if (data.markdown_content) {
          // Open the plan where the chat sits and remember what it displaced.
          // Only the agent has to wait for this answer, so the editor, the
          // explorer and the terminal stay live while the user checks the plan
          // against the files it names.
          if (layoutModeRef.current !== 'plan') planReturnLayoutRef.current = layoutModeRef.current;
          setLayoutMode('plan');
          // A maximized editor hides every dock, and the modal this panel
          // replaced was never hidden by anything: an arriving plan has to be
          // on screen, or the turn stalls on a question the user cannot see.
          setIsEditorMaximized(false);
        }
        addLog('info', t('app.waitingConfirmation', '🔔 Aguardando confirmação: {{prompt}}', { prompt: data.prompt }));
        break;
      case 'error':
        addLog('error', data.message);
        addProblem({ tool: data.agent || t('app.agentTool', 'Agent'), message: data.message, severity: 'error' });
        setChatMessages(prev => [...prev, { role: 'assistant', content: t('app.agentError', '🔴 Erro do Agente: {{message}}', { message: data.message }), is_error: true, timestamp: new Date().toISOString() }]);
        break;
      case 'problem':
        addLog('error', t('app.toolProblem', { tool: data.tool, message: data.message }));
        addProblem({ tool: data.tool, message: data.message, severity: data.severity || 'error' });
        break;
      default: addLog('info', t('app.eventReceived', { event }));
    }
  };

  const makeClientMessageId = () => {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  };

  const setMessageDeliveryState = (clientMessageId, deliveryState) => {
    setChatMessages(prev => prev.map(msg => (
      msg.client_message_id === clientMessageId ? { ...msg, _deliveryState: deliveryState } : msg
    )));
  };

  // Hand a message to the turn already running. The agent picks it up at its next
  // boundary — after the tool call in flight, before the next model call — so the
  // message passes through three reported states: 'sending' while the request is
  // in flight, 'queued' once the backend accepted it, and 'delivered' once the
  // agent has actually read it. Delivery is never instant, and the difference
  // between "waiting" and "read" is the whole question the user is asking, so
  // both are stated rather than implied by the absence of a badge.
  const queueMessageForRunningAgent = async (text, attachments, chatId) => {
    const clientMessageId = makeClientMessageId();
    setChatMessages(prev => [...prev, {
      role: 'user',
      content: text || '📎 Attachment',
      client_message_id: clientMessageId,
      _attachments: attachments,
      _deliveryState: 'sending',
      timestamp: new Date().toISOString(),
      chat_id: chatId,
    }]);
    setQueuedMessages(prev => [...prev, { clientMessageId, itemId: '', text, attachments, chatId }]);

    let result = {};
    try {
      const res = await fetch('/api/opalatex/message', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: text,
          display_text: text,
          attachments,
          project_path: activeProject?.project_path || '',
          chat_id: chatId,
          client_message_id: clientMessageId,
        }),
      });
      result = await res.json().catch(() => ({}));
      if (res.ok) {
        setQueuedMessages(prev => prev.map(m => (
          m.clientMessageId === clientMessageId ? { ...m, itemId: result.item_id || '' } : m
        )));
        setMessageDeliveryState(clientMessageId, 'queued');
        addLog('info', t('app.messageQueued', 'Message queued for the running agent.'));
        return;
      }
      if (result.reason === 'no_active_run') {
        // The turn ended between typing and this request. The entry stays queued
        // and the flush effect below sends it as an ordinary next turn — so it is
        // waiting, not still being sent.
        setMessageDeliveryState(clientMessageId, 'queued');
        return;
      }
      throw new Error(result.error || t('app.messageQueueFailed', 'The message could not be queued.'));
    } catch (err) {
      // Refused: drop the bubble and give the text back to the composer instead
      // of showing a message that will never reach the agent.
      setChatMessages(prev => prev.filter(m => m.client_message_id !== clientMessageId));
      setQueuedMessages(prev => prev.filter(m => m.clientMessageId !== clientMessageId));
      setChatInput(prev => (prev.trim() ? prev : text));
      setPendingAttachments(prev => (prev.length ? prev : attachments));
      addLog('error', t('app.messageQueueError', 'Could not queue the message: {{error}}', { error: err.message }));
    }
  };

  const handleCancelQueuedMessage = async (clientMessageId) => {
    const entry = queuedMessages.find(m => m.clientMessageId === clientMessageId);
    if (!entry) return;
    if (entry.itemId) {
      try {
        const res = await fetch('/api/opalatex/message/cancel', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ item_id: entry.itemId }),
        });
        // 404 means the agent already took it: it is part of the conversation
        // now, and removing the bubble would hide a message the model has read.
        if (!res.ok) return;
      } catch (err) {
        addLog('error', t('app.messageCancelError', 'Could not cancel the message: {{error}}', { error: err.message }));
        return;
      }
    }
    setQueuedMessages(prev => prev.filter(m => m.clientMessageId !== clientMessageId));
    setChatMessages(prev => prev.filter(m => m.client_message_id !== clientMessageId));
  };

  const handleCancelAllQueuedMessages = async () => {
    const pending = [...queuedMessages];
    for (const entry of pending) {
      await handleCancelQueuedMessage(entry.clientMessageId);
    }
  };

  const handleSendMessage = async (e, retryMsg = null, options = {}) => {
    if (e && e.preventDefault) e.preventDefault();
    const targetChatId = options.chatIdOverride || activeChatId;

    let userText = '';
    let displayText = '';
    let attachmentsSnapshot = [];
    let messagesForRequest = undefined;
    let clientMessageId = options.clientMessageId || retryMsg?.client_message_id || retryMsg?.clientMessageId || '';

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
      if ((!chatInput.trim() && pendingAttachments.length === 0) || !activeProject) return;
      userText = chatInput;
      displayText = userText;
      attachmentsSnapshot = [...pendingAttachments];
      setChatInput('');
      setPendingAttachments([]);
      if (isAgentRunning) {
        // A slash command is a client-side operation on the chat the agent is
        // using (/clear erases the history it is answering from), not something
        // to hand the model as text. Refuse it while a turn runs instead of
        // silently sending it as a message.
        if (userText.trim().startsWith('/')) {
          setChatInput(userText);
          setPendingAttachments(attachmentsSnapshot);
          addLog('error', t('app.slashCommandWhileRunning', 'Slash commands cannot run while the agent is working. Stop the agent first.'));
          return;
        }
        // The composer stays live during a turn. This message joins the turn in
        // flight instead of waiting for it to end, so it does not start a run of
        // its own here.
        await queueMessageForRunningAgent(userText, attachmentsSnapshot, targetChatId);
        return;
      }
    }
    if (!clientMessageId) {
      clientMessageId = makeClientMessageId();
    }
    if (options.supersedeFrom) {
      try {
        // Anchor the cut on the stored message id (or its client id), never on a
        // UI position: the rendered list and the stored rows do not line up, and a
        // wrong position would supersede unrelated turns.
        const truncateRes = await fetch('/api/chat/truncate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project_name: activeProject.name,
            chat_id: targetChatId,
            message_id: options.supersedeFrom.messageId ?? undefined,
            client_message_id: options.supersedeFrom.clientMessageId || '',
            superseded_by: clientMessageId,
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
    const userMsg = {
      role: 'user',
      content: userText || '📎 Attachment',
      client_message_id: clientMessageId,
      _attachments: attachmentsSnapshot,
      timestamp: new Date().toISOString(),
      chat_id: targetChatId,
    };
    if (!options.skipUserMessageAppend) {
      setChatMessages(prev => {
        if (options.baseMessages) {
          return [...options.baseMessages, userMsg];
        }
        if (options.replaceUiIndex !== undefined) {
          return [...prev.slice(0, options.replaceUiIndex), userMsg];
        }
        if (retryMsg) {
          const idx = prev.indexOf(retryMsg);
          if (idx !== -1) {
            return [...prev.slice(0, idx), userMsg];
          }
        }
        return [...prev, userMsg];
      });
    }
    setIsAgentRunning(true);
    setIsInterruptPending(false);
    setProblems([]);
    setAchievementsMemory('');
    chatThoughtStreamRef.current = '';
    setChatThoughtStream('');
    chatResponseStreamRef.current = '';
    setChatResponseStream('');
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
          // /clear and /clear_chat erase the context the indicator described.
          setChatContextUsage(contextUsageFromPayload(result.context_usage));
          setChatMessages(prev => [...prev, { role: 'assistant', content: (result.messages || []).join('\n') || 'Comando executado.', timestamp: new Date().toISOString() }]);
        } else {
          setChatMessages(prev => [...prev, { role: 'assistant', content: `🔴 Erro: ${result.error || 'desconhecido'}`, is_error: true, timestamp: new Date().toISOString() }]);
        }
      } catch (err) {
        addLog('error', t('app.commandFailed', { error: err.message }));
        setChatMessages(prev => [...prev, { role: 'assistant', content: `🔴 Falha: ${err.message}`, is_error: true, timestamp: new Date().toISOString() }]);
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
          display_prompt: displayText || userText || '',
          project_name: activeProject.name, project_path: activeProject.project_path,
          model: activeProject.model,
          worker_model: activeProject.worker_model,
          model_params: activeProject.model_params,
          worker_model_params: activeProject.worker_model_params,
          current_file: selectedFile || '',
          open_files: openFiles,
          editor_content: fileContent || '', selected_text: selectedText || '',
          lang: i18n.language || 'en',
          chat_id: targetChatId,
          client_message_id: clientMessageId,
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
      setChatMessages(prev => [...prev, { role: 'assistant', content: `🔴 Falha na execução: ${err.message}`, is_error: true, timestamp: new Date().toISOString() }]);
    } finally { setIsAgentRunning(false); setIsInterruptPending(false); fetchFiles(); fetchProblems(); }
  };

  // A message the turn ended without delivering becomes an ordinary next turn.
  // It goes back through handleSendMessage rather than through a shortcut, so it
  // keeps its attachments, its turn checkpoint and its stored identity: a queued
  // message must not end up as a lesser kind of message. One per pass — starting
  // a turn re-runs this effect for whatever is still queued.
  useEffect(() => {
    if (isAgentRunning || !activeProject || queuedMessages.length === 0) return;
    const next = queuedMessages[0];
    setQueuedMessages(prev => prev.filter(m => m.clientMessageId !== next.clientMessageId));
    setChatMessages(prev => prev.filter(m => m.client_message_id !== next.clientMessageId));
    handleSendMessage(null, null, {
      overrideText: next.text,
      overrideAttachments: next.attachments,
      clientMessageId: next.clientMessageId,
      chatIdOverride: next.chatId,
    });
  }, [isAgentRunning, queuedMessages, activeProject]);

  const handleFixLatexProblem = async (problem) => {
    if (!activeProject || isAgentRunning || !problem) return;
    setIsChatVisible(true);
    try {
      const prompt = buildLatexFixPrompt(problem);
      const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const chatName = `${t('app.fixLatexChatName', 'Fix LaTeX error')} ${timestamp}`;
      const { chatId, baseMessages } = await createChatForTask(chatName);
      await handleSendMessage(null, null, {
        overrideText: prompt,
        displayText: buildLatexFixDisplayText(problem),
        chatIdOverride: chatId,
        baseMessages,
      });
    } catch (err) {
      addLog('error', t('app.fixLatexChatCreateFailed', 'Failed to create a new chat for the LaTeX fix: {{error}}', { error: err.message }));
    }
  };

  const buildAskAboutPdfPrompt = ({ pdfPath, sourceFile, page, totalPages, selectedText }) => {
    const location = totalPages
      ? `${t('app.pdfPageLabel', 'Page')} ${page}/${totalPages}`
      : `${t('app.pdfPageLabel', 'Page')} ${page}`;
    return [
      `${t('app.askAboutPdfPrompt', 'Consulting about')} ${pdfPath}`,
      '',
      `- ${t('app.projectPathLabel', 'Project path')}: ${activeProject?.project_path || ''}`,
      sourceFile && sourceFile !== pdfPath
        ? `- ${t('app.pdfSourceFileLabel', 'LaTeX source open in the editor')}: ${sourceFile}`
        : '',
      `- ${location}`,
      '',
      selectedText
        ? [
          `${t('app.pdfSelectedExcerptLabel', 'Excerpt selected in the PDF viewer')}:`,
          '````text',
          selectedText,
          '````',
          '',
        ].join('\n')
        : '',
      // Left open on purpose: the composer is pre-filled, not sent, so the
      // caret lands here for the user to finish the question and press Send.
      t('app.askAboutPdfQuestionLabel', 'My question:') + ' ',
    ].filter((part) => part !== '').join('\n');
  };

  // "Ask about" only stages the question: it opens the chat and pre-fills the
  // composer so the user completes the prompt and sends it themselves. It never
  // starts a turn, and it never replaces text the user has already typed.
  const handleAskAboutPdf = (details) => {
    if (!activeProject || !details?.pdfPath) return;
    setIsChatVisible(true);
    const prompt = buildAskAboutPdfPrompt(details);
    setChatInput((prev) => (prev.trim() ? `${prev.replace(/\s+$/, '')}\n\n${prompt}` : prompt));
    setChatInputFocusSignal((prev) => prev + 1);
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
    const messageAnchor = {
      messageId: numericMessageId(originalMessage),
      clientMessageId: String(originalMessage.client_message_id || '').trim(),
    };
    if (!messageAnchor.messageId && !messageAnchor.clientMessageId) {
      addLog('error', t('app.editAnchorMissing', 'This message cannot be edited: it has no stored identifier.'));
      return;
    }
    if (messageIndex === lastUserIndex) {
      await handleSendMessage(null, null, {
        overrideText: nextContent,
        overrideAttachments: attachments,
        supersedeFrom: messageAnchor,
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
          message_id: messageAnchor.messageId ?? undefined,
          client_message_id: messageAnchor.clientMessageId || '',
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
      if (activeProject) localStorage.setItem(`lastChat_${activeProject.name}`, newChatId);
      setChats(prev => [...prev, { id: newChatId, name: data.name || newChatName }]);
      // The branched chat has its own (shorter) history: the source chat's
      // measured window does not describe it.
      setChatContextUsage(null);
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
    if (message.client_message_id) {
      // The stored row is reused (append_message dedupes on client_message_id),
      // so the user turn is answered again without being rewritten.
      await handleSendMessage(null, null, {
        overrideText: content,
        overrideAttachments: attachments,
        clientMessageId: message.client_message_id,
        skipUserMessageAppend: true,
      });
      return;
    }
    const messageId = numericMessageId(message);
    if (messageId === null) {
      addLog('error', t('app.retryAnchorMissing', 'This message cannot be retried: it has no stored identifier.'));
      return;
    }
    await handleSendMessage(null, null, {
      overrideText: content,
      overrideAttachments: attachments,
      supersedeFrom: { messageId, clientMessageId: '' },
      replaceUiIndex: messageIndex,
    });
  };

  const sendConfirmResponse = async (value) => {
    if (!confirmRequest) return;
    const currentRequest = confirmRequest;
    const { id, prompt, isSlashCommand, callback } = currentRequest;
    const isPlan = !!currentRequest.markdown_content;
    setConfirmRequest(null);
    if (isPlan) {
      setLayoutMode(planReturnLayoutRef.current || 'ide');
      // Only a rejection needs the chat: it halts the turn, and the user's next
      // move is to type what to change. An approval leaves the chat exactly as
      // visible as they had left it.
      if (value === 'no') setIsChatVisible(true);
    }

    if (callback) {
      callback(value);
      return;
    }

    addLog('info', t('app.confirmationValue', { prompt, value }));
    try {
      if (isSlashCommand) {
        const res = await fetch('/api/opalatex/slash-command/continue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, value }) });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(text || `HTTP ${res.status}`);
        }
        const result = await res.json();
        if (result.status === 'done') {
          setChatMessages(prev => [...prev, { role: 'assistant', content: (result.messages || []).join('\n') || 'Comando executado.', timestamp: new Date().toISOString() }]);
          fetchFiles();
          fetchGitStatus();
        }
      } else {
        const res = await fetch('/api/opalatex/input_response', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, value }) });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(text || `HTTP ${res.status}`);
        }
      }
    } catch (err) {
      setConfirmRequest(currentRequest);
      // The backend never got the answer, so the plan is still pending: put the
      // user back in front of it rather than leaving it only behind the badge.
      if (isPlan) setLayoutMode('plan');
      addLog('error', t('app.confirmationSendError', { error: err.message }));
      addProblem({ tool: t('app.agentTool', 'Agent'), message: t('app.confirmationRejectedByBackend', { error: err.message }), severity: 'error' });
    }
  };

  // ── Editor mount ──────────────────────────────────────────────────────────
  const handleEditorDidMount = (editor, monaco) => {
    editorRef.current = editor;
    if (monaco) monacoRef.current = monaco;

    editor.onDidChangeModelContent(() => {
      lastEditorInputAtRef.current = Date.now();
      fileContentRef.current = editor.getValue();
    });

    editor.onKeyDown((e) => {
      const ev = e.browserEvent;
      const isCtrl = ev.ctrlKey || ev.metaKey;
      if (isCtrl && (ev.key === '+' || ev.key === '=' || ev.code === 'Equal' || ev.code === 'NumpadAdd')) {
        ev.preventDefault(); ev.stopPropagation();
        setEditorFontSize(prev => { const v = Math.min(30, prev + 1); safeSetLocalStorage('editorFontSize', v); return v; });
      } else if (isCtrl && (ev.key === '-' || ev.code === 'Minus' || ev.code === 'NumpadSubtract')) {
        ev.preventDefault(); ev.stopPropagation();
        setEditorFontSize(prev => { const v = Math.max(10, prev - 1); safeSetLocalStorage('editorFontSize', v); return v; });
      }
    });

    // Ctrl+S is registered as a Monaco command rather than matched on
    // browserEvent.key: the keybinding service resolves the physical key, so the
    // shortcut survives runtimes where the character cannot be resolved. This is
    // how every other editor shortcut (Ctrl+J, Ctrl+F, Ctrl+L) is already bound.
    if (monaco) {
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        saveFileRef.current?.();
      });
    }
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
    const startColumn = inlinePrompt.startColumn ?? 1;
    const endColumn = inlinePrompt.endColumn ?? inlinePrompt.cursorCol ?? 1;

    const editorModel = editorRef.current?.getModel?.();
    const currentEditorContent = editorModel?.getValue?.() ?? fileContent ?? '';
    const cursorColumn = inlinePrompt.cursorCol ?? startColumn;
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

      if (hasSelection && mode !== 'generate') {
        fullPrompt = `Task: ${verb}\n\nFile Context:\n${fence}\n${currentEditorContent}\n\`\`\`\n\nTarget Selection to Replace:\n${fence}\n${selectedText}\n\`\`\``;
      } else {
        const cursorOffset = editorModel?.getOffsetAt?.({ lineNumber: startLine, column: cursorColumn });
        const beforeCursor = currentEditorContent.slice(0, cursorOffset ?? 0);
        const afterCursor = currentEditorContent.slice(cursorOffset ?? 0);
        fullPrompt = `Task: ${instruction}\n\nThe following is read-only context. The <cursor> tag is application metadata, not source content. It marks the exact insertion point; do not count lines, locate a position, reconcile line numbers, or reproduce the file. Generate only the requested snippet for that point.\n\n<file_context file=${JSON.stringify(selectedFile || '')}>\n<before_cursor>\n${beforeCursor}\n</before_cursor>\n<cursor line="${startLine}" column="${cursorColumn}" />\n<after_cursor>\n${afterCursor}\n</after_cursor>\n</file_context>`;
      }

      systemPrompt = "You are a precise inline content editor for any selected content: text, Markdown, LaTeX, code, config files, JSON, YAML, tables, or structured data. " +
        "CRITICAL: Do NOT create, modify, or save files. " +
        "Tools and function calls are unavailable for this task; do not request or attempt them. " +
        "All necessary context is already included in the user prompt; complete the task by returning the replacement content directly. " +
        "Return ONLY the final replacement source, without Markdown fences or any transport envelope. " +
        "Do not add Markdown fences around the replacement, including when it contains code or LaTeX. " +
        "Do NOT include greetings, explanations, comments, summaries, tool calls, or any surrounding text. " +
        "Preserve the original language, format, structure, and intent unless the requested edit requires changes. " +
        "For insertion tasks, the host application owns the cursor position. The <cursor> tag is authoritative metadata: use surrounding content only for context, and never count lines, choose another insertion point, or explain your placement. " +
        "Be objective, concise, and direct. " +
        "Legacy fence examples below are accepted for compatibility but are not required:\n" +
        "Original: 'O sistema é bom.' → ````content\\nO sistema é funcional.\\n```` " +
        "Original: 'flowchart LR\\n  A --> B' → ````content\\nflowchart LR\\n  A[Start] --> B[End]\\n```` " +
        "Original: '$$ E = m c ^ 2 $$' → ````content\\n$$\\nE = mc^2\\n$$\\n```` " +
        "Your entire output must contain only the replacement source.";
    }

    setChatInput('');
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
          inline_response_contract: mode === 'createIllustration' ? undefined : 'replacement_only',
          current_file: selectedFile || '',
          open_files: openFiles,
          editor_content: currentEditorContent,
          selected_text: selectedText || '',
          lang: i18n.language || 'en',
          // Inline runs preserve all user-selected parameters, except streaming:
          // this agent returns one final replacement and must not emit partial output.
          model_params: { ...ephemeralParams, stream: false }
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
              // Inline generation has no live-output contract. Only its final
              // agent_response may be applied to the editor.
              continue;
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
          const match4Content = extractInlineReplacementBlock(rawResponse);
          const match4 = match4Content !== null ? [null, null, match4Content] : null;
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
            const model = editorRef.current.getModel();
            const range = new monacoRef.current.Range(startLine, startColumn, endLine, endColumn);
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
    if (!userText.trim() || !activeProject || isAgentRunning) return;
    setChatInput('');
    setChatMessages(prev => [...prev, { role: 'user', content: userText, timestamp: new Date().toISOString() }]);
    setIsAgentRunning(true);
    setIsInterruptPending(false);
    setProblems([]);
    chatThoughtStreamRef.current = '';
    setChatThoughtStream('');
    chatResponseStreamRef.current = '';
    setChatResponseStream('');
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
        body: JSON.stringify({ command: 'run', agent: 'chat_orchestrator', prompt: userText, project_name: activeProject.name, project_path: activeProject.project_path, model: activeProject.model, current_file: selectedFile || '', open_files: openFiles, editor_content: fileContent || '', selected_text: selectedText || '', lang: i18n.language || 'en', chat_id: activeChatId, model_params: ephemeralParams }),
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
      setChatMessages(prev => [...prev, { role: 'assistant', content: `🔴 Falha na execução: ${err.message}`, is_error: true, timestamp: new Date().toISOString() }]);
    } finally { setIsAgentRunning(false); setIsInterruptPending(false); fetchFiles(); fetchProblems(); }
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="vscode-app">
      <input
        ref={importFileInputRef}
        type="file"
        multiple
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
          onOpenAssetStore={() => setIsAssetStoreOpen(true)}
          onOpenCloudSync={() => setIsCloudSyncOpen(true)}
          cloudEnabled={!!cloudStatus?.settings?.enabled}
          onOpenTutorial={handleOpenTutorial}
          layoutMode={layoutMode}
          setLayoutMode={setLayoutMode}
          hasOpenDocument={!!selectedFile}
          isTerminalCollapsed={isTerminalCollapsed}
          setIsTerminalCollapsed={setIsTerminalCollapsed}
          setActiveBottomTab={setActiveBottomTab}
          hasPendingPlan={!!planRequest}
          onOpenPlan={() => { setIsEditorMaximized(false); setLayoutMode('plan'); }}
          onOpenProjectSettings={(e) => { if (activeProject) openEditModal(e, activeProject); }}
          hasActiveProject={!!activeProject}
        />

        {/* Left Sidebar */}
        {!isEditorMaximized && activeSidebarTab && isEditorLayout && (
          <aside className="vscode-sidebar" style={{ width: `${sidebarWidth}px` }}>
            {activeSidebarTab === 'explorer' ? (
              <ExplorerSidebar
                projects={projects}
                activeProject={activeProject}
                handleSelectProject={handleSelectProject}
                onNewProject={() => { setShowNewProjectModal(true); setNewProjModelParams({}); }}
                onImportProject={() => { setImportError(''); openDirPicker('import', '~'); }}
                onDownloadFromCloud={openCloudDownload}
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
                showHiddenWorkspaceFiles={showHiddenWorkspaceFiles}
                onShowHiddenWorkspaceFilesChange={handleShowHiddenWorkspaceFilesChange}
                openEditModal={openEditModal}
                handleDeleteProject={handleDeleteProject}
                renamingNodePath={renamingNodePath}
                setRenamingNodePath={setRenamingNodePath}
                executeRenameNode={executeRenameNode}
                cloudFileStates={cloudFileStates}
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
                onStageAllFiles={handleStageAllFiles}
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
        {!isEditorMaximized && isChatLayout && (
          <aside className="vscode-sidebar" style={{ width: `${sidebarWidth}px`, display: 'flex', flexDirection: 'column' }}>
            <div className="vscode-chat-sidebar-history-pane">
              <ChatSidebar
                chats={chats}
                activeChatId={activeChatId}
                setActiveChatId={setActiveChatId}
                mainChatId={mainChatId}
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
                onDownloadFromCloud={openCloudDownload}
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
                renamingNodePath={renamingNodePath}
                setRenamingNodePath={setRenamingNodePath}
                executeRenameNode={executeRenameNode}
                cloudFileStates={cloudFileStates}
              />
            </div>
          </aside>
        )}

        {/* Left resize handle */}
        {!isEditorMaximized && ((activeSidebarTab && isEditorLayout) || isChatLayout) && (
          <div className="vscode-resizer-horizontal" onMouseDown={(e) => startResizing(e, 'left')} />
        )}

        {/* Center — Editor + Bottom Panel */}
        <main
          className={`vscode-editor-panel ${layoutMode === 'chat-bottom' ? 'vscode-chat-bottom-layout' : ''} ${isStudioLayout ? 'vscode-studio-layout' : ''}`}
          style={{
            flex: layoutMode === 'chat' ? 0 : 1,
            display: layoutMode === 'chat' ? 'none' : isStudioLayout ? 'grid' : 'flex',
            // Inline, because the flex/grid switch above is inline too and a
            // class-level template would lose to it.
            ...(isStudioLayout ? { gridTemplateColumns: studioGrid.gridTemplateColumns, gridTemplateRows: studioGrid.gridTemplateRows } : {}),
          }}
        >
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

          {!isBottomMaximized && isEditorLayout && (
            <EditorPanel
              selectedFile={selectedFile}
              openFiles={openFiles}
              fileContent={fileContent}
              fileContents={fileContents}
              originalFileContents={originalFileContents}
              isSaving={isSaving}
              theme={theme}
              uiScale={uiScale}
              editorFontSize={editorFontSize}
              setEditorFontSize={setEditorFontSize}
              editorTabSize={editorTabSize}
              editorWordWrap={editorWordWrap}
              editorMinimap={editorMinimap}
              handleFileSelect={handleFileSelect}
              handleCloseTab={handleCloseTab}
              handleCloseOtherTabs={handleCloseOtherTabs}
              handleCloseAllTabs={handleCloseAllTabs}
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
                  setBottomPanelHeight(Math.floor(viewportPxToApp(window.innerHeight) / 2));
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
              onCompileRequestHandled={(requestId) => {
                setTriggerCompileRequest(prev => (
                  prev?.id === requestId ? null : prev
                ));
              }}
              onLatexCompileError={handleLatexCompileError}
              onLatexCompileSuccess={handleLatexCompileSuccess}
              onFixLatexProblem={handleFixLatexProblem}
              onAskAboutPdf={handleAskAboutPdf}
              isAgentRunning={isAgentRunning}
              onTextStatsChange={setEditorTextStats}
              openPreviewByDefault={isStudioLayout || isDocumentLayout}
            />
          )}

          {/* Studio drag handles. They are grid items like the panels, so they
              sit between the cells without wrapping anything in a container —
              which is what keeps the panels' tree positions untouched. */}
          {isStudioLayout && studioGrid.showRowResizer && (
            <div
              className="vscode-resizer-vertical vscode-studio-row-resizer"
              onMouseDown={(e) => startResizing(e, 'studio-bottom')}
            />
          )}
          {isStudioLayout && studioGrid.showColumnResizer && (
            <div
              className="vscode-resizer-horizontal vscode-studio-col-resizer"
              onMouseDown={(e) => startResizing(e, 'studio-chat')}
            />
          )}

          {((layoutMode === 'chat-bottom' && !isBottomMaximized)
            || (isStudioLayout && isChatVisible && !isEditorMaximized)) && (
            <ChatPanel
              isChatMode={!isStudioLayout}
              fillContainer={isStudioLayout}
              isTutorialChat={Boolean(tutorialChatId) && activeChatId === tutorialChatId}
              tutorialTopics={tutorialTopics}
              onTutorialTopic={handleTutorialTopic}
              chatMessages={chatMessages}
              chatInput={chatInput}
              setChatInput={setChatInput}
              chatInputFocusSignal={chatInputFocusSignal}
              isAgentRunning={isAgentRunning}
              queuedMessages={queuedMessages}
              onCancelQueuedMessage={handleCancelQueuedMessage}
              onCancelAllQueuedMessages={handleCancelAllQueuedMessages}
              isInterruptPending={isInterruptPending}
              chatThoughtStream={chatThoughtStream}
              chatResponseStream={chatResponseStream}
              chatContextUsage={chatContextUsage}
              setChatContextUsage={setChatContextUsage}
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
                setChatMessages(currentProjName ? [{ role: 'assistant', content: t('app.greeting', { projectName: currentProjName }) }] : []);
              }}
              chatEndRef={chatEndRef}
              webSearchConfig={webSearchConfig}
              setWebSearchConfig={setWebSearchConfig}
              activeChatId={activeChatId}
              setActiveChatId={setActiveChatId}
              mainChatId={mainChatId}
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
            />
          )}
          <div
            className={isStudioLayout ? 'vscode-studio-terminal-cell' : undefined}
            style={{
              display: isStudioLayout
                ? (isEditorMaximized || isTerminalCollapsed ? 'none' : 'flex')
                : (isEditorMaximized || (layoutMode !== 'ide' && layoutMode !== 'chat-bottom' && layoutMode !== 'plan') ? 'none' : 'contents'),
            }}
          >
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
              fillContainer={isStudioLayout}
            />
          </div>
        </main>

        {/* Right resize handle */}
        {!isEditorMaximized && ((isChatVisible && layoutMode === 'ide') || (planRequest && layoutMode === 'plan')) && (
          <div className="vscode-resizer-horizontal" onMouseDown={(e) => startResizing(e, 'right')} />
        )}

        {/* Chat Panel */}
        {(!isEditorMaximized && layoutMode !== 'review' && layoutMode !== 'chat-bottom' && layoutMode !== 'plan' && !isDocumentLayout && !isStudioLayout && (isChatVisible || layoutMode === 'chat')) && (
          <>
            <ChatPanel
              isChatMode={layoutMode === 'chat'}
              isTutorialChat={Boolean(tutorialChatId) && activeChatId === tutorialChatId}
              tutorialTopics={tutorialTopics}
              onTutorialTopic={handleTutorialTopic}
              chatMessages={chatMessages}
              chatInput={chatInput}
              setChatInput={setChatInput}
              chatInputFocusSignal={chatInputFocusSignal}
              isAgentRunning={isAgentRunning}
              queuedMessages={queuedMessages}
              onCancelQueuedMessage={handleCancelQueuedMessage}
              onCancelAllQueuedMessages={handleCancelAllQueuedMessages}
              isInterruptPending={isInterruptPending}
              chatThoughtStream={chatThoughtStream}
              chatResponseStream={chatResponseStream}
              chatContextUsage={chatContextUsage}
              setChatContextUsage={setChatContextUsage}
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
              mainChatId={mainChatId}
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

        {/* Proposed plan — the panel that replaced the blocking approval
            modal. It is a sibling of the chat rather than a replacement
            inside it, so entering and leaving the plan layout never reparents
            the chat's own tree. */}
        {!isEditorMaximized && layoutMode === 'plan' && planRequest && (
          <PlanPanel
            planRequest={planRequest}
            onRespond={sendConfirmResponse}
            chatWidth={chatWidth}
          />
        )}
      </div>

      {/* Status Bar */}
      <StatusBar
        activeProject={activeProject}
        isAgentRunning={isAgentRunning}
        textStats={editorTextStats}
        cloudStatus={cloudStatus}
        onOpenCloudSync={() => setIsCloudSyncOpen(true)}
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
          onClose={() => setIsSettingsOpen(false)}
          settingsTab={settingsTab}
          setSettingsTab={setSettingsTab}
          theme={theme} setTheme={setTheme}
          uiScale={uiScale} applyUiScale={applyUiScale}
          editorFontSize={editorFontSize} setEditorFontSize={setEditorFontSize}
          editorTabSize={editorTabSize} setEditorTabSize={setEditorTabSize}
          editorWordWrap={editorWordWrap} setEditorWordWrap={setEditorWordWrap}
          editorMinimap={editorMinimap} setEditorMinimap={setEditorMinimap}
          isInstallingDeps={isInstallingDeps}
          installDepsStatus={installDepsStatus}
          installDepsLog={installDepsLog}
          onInstallDeps={handleInstallOptionalDeps}
          ephemeralParams={ephemeralParams}
          setEphemeralParams={setEphemeralParams}
          panelMaxLines={panelMaxLines}
          setPanelMaxLines={(val) => { setPanelMaxLines(val); safeSetLocalStorage('panelMaxLines', val); }}
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

      {isAssetStoreOpen && (
        <AssetStoreModal
          onClose={() => setIsAssetStoreOpen(false)}
          projectPath={activeProject?.project_path}
          onWorkspaceChanged={refreshWorkspaceFiles}
        />
      )}

      {isCloudSyncOpen && (
        <CloudSyncModal
          activeProject={activeProject}
          onClose={() => { setIsCloudSyncOpen(false); refreshCloudStatus(); }}
          onWorkspaceChanged={refreshWorkspaceFiles}
        />
      )}

      {isCloudDownloadOpen && (
        <CloudDownloadModal
          parentPath={cloudDownloadParent}
          onPickParentPath={() => openDirPicker('cloud-download', cloudDownloadParent || '~')}
          onClose={() => setIsCloudDownloadOpen(false)}
          onDownloaded={handleProjectDownloaded}
        />
      )}

      {showOnboarding && <OnboardingModal onComplete={handleOnboardingComplete} />}

      {confirmRequest && confirmRequest.type === 'interactive_terminal' ? (
        <InteractiveTerminalModal request={confirmRequest} onConfirm={sendConfirmResponse} activeProject={activeProject} />
      ) : confirmRequest && confirmRequest.type === 'ask' ? (
        <AskModal askRequest={confirmRequest} onConfirm={sendConfirmResponse} />
      ) : confirmRequest && !planRequest ? (
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

      <MoveToModal
        moveModal={moveModal}
        files={files}
        isFileInsidePath={isFileInsidePath}
        onConfirm={confirmMoveModal}
        onClose={() => setMoveModal(null)}
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
        handleMoveToNode={handleOpenMoveModal}
        clipboardNode={clipboardNode}
      />

      {showEditModelsModal && (
        <EditModelsModal
          globalModels={globalModels}
          onClose={() => setShowEditModelsModal(false)}
          onDeleteModel={handleGlobalModelDelete}
          onEditModel={(model) => {
            setEditingModelModalData(model);
            setShowAddModelModal(true);
          }}
          onAddModel={() => {
            setEditingModelModalData(null);
            setShowAddModelModal(true);
          }}
          onManageConnections={() => setShowEditProvidersModal(true)}
          onLoadLocalOllama={handleLoadLocalOllamaModels}
        />
      )}

      {showAddModelModal && (
        <AddModelModal
          editingModel={editingModelModalData}
          existingModels={globalModels}
          connections={providerConnections}
          onSaveConnection={handleConnectionSave}
          onClose={() => setShowAddModelModal(false)}
          onSave={handleGlobalModelSave}
        />
      )}

      {showEditProvidersModal && (
        <EditProvidersModal
          connections={providerConnections}
          models={globalModels}
          onClose={() => setShowEditProvidersModal(false)}
          onDeleteConnection={handleConnectionDelete}
          onEditConnection={(connection) => {
            setEditingConnectionModalData(connection);
            setShowAddConnectionModal(true);
          }}
          onAddConnection={() => {
            setEditingConnectionModalData(null);
            setShowAddConnectionModal(true);
          }}
        />
      )}

      {showAddConnectionModal && (
        <AddConnectionModal
          editingConnection={editingConnectionModalData}
          existingConnections={providerConnections}
          onClose={() => setShowAddConnectionModal(false)}
          onSave={handleConnectionSave}
        />
      )}
    </div>
  );
}
