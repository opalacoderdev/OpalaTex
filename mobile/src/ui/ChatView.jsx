import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ChevronDown, Copy, GitBranch, MoreHorizontal, Pencil, RotateCcw, Send, Square, X } from 'lucide-react';
import Markdown from './Markdown.jsx';
import ApprovalSheet from './ApprovalSheet.jsx';
import ModelPicker, { connectionLabel } from './ModelPicker.jsx';
import { SyncStatus } from './ProjectView.jsx';
import { copyText } from './clipboard.js';
import { createCompletion, portableParams, resolveChoice, resolveModel } from '../agent/providers.js';
import { createTools } from '../agent/tools.js';
import { effectiveModel, getApiKey, withModelChoice } from '../project/settings.js';
import { branchChat, runChatTurn } from '../project/turn.js';
import i18n from '../i18n';

const TOAST_MS = 2000;

export default function ChatView({
  services, settings, project, session, conversation, chat, initialDraft, onDraftUsed,
  onBack, onChatCreated, onChanged, onBusy, onOpenSettings, onSettingsChange, status, showBack = true,
}) {
  const { t } = useTranslation();
  const [text, setText] = useState(initialDraft || '');
  const [live, setLive] = useState(null);
  // A failure belongs to the chat it happened in; another chat opened in the
  // same view (two-pane layout) must not show it.
  const [failure, setFailure] = useState(null);
  const [notice, setNotice] = useState('');
  const [approval, setApproval] = useState(null);
  const [picking, setPicking] = useState(false);
  const [actionsFor, setActionsFor] = useState(null);
  const [editing, setEditing] = useState(null);
  const [toast, setToast] = useState('');
  const abortRef = useRef(null);
  const endRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => { if (initialDraft) onDraftUsed?.(); }, [initialDraft, onDraftUsed]);
  useEffect(() => { setEditing(null); setActionsFor(null); }, [chat?.id]);
  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(''), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  const desktopModelId = conversation?.settings?.model || '';
  const effective = effectiveModel(settings, project.root, chat?.id, conversation?.settings);
  const resolved = useMemo(
    () => (effective.kind === 'choice' ? resolveChoice(effective.choice, settings.connections) : resolveModel(effective.modelId, settings.connections)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(effective), settings.connections],
  );
  const modelLabel = resolved.ok
    ? `${resolved.model} · ${connectionLabel(resolved.connection)}`
    : (effective.kind === 'choice' ? effective.choice.model : effective.modelId) || t('chat.chooseModel');
  const modelProblem = !resolved.ok ? ({
    'no-model': settings.connections.length ? t('chat.noModelAtAll') : t('picker.empty'),
    'no-provider': t('chat.noProvider', { model: effective.modelId }),
    'no-connection': t('chat.noModel', { provider: resolved.provider }),
    'no-base-url': t('chat.noBaseUrl', { provider: resolved.provider }),
    'connection-removed': t('chat.connectionRemoved'),
  }[resolved.reason]) : '';

  const pickModel = (choice) => {
    onSettingsChange(withModelChoice(settings, project.root, chat?.id, choice));
    setPicking(false);
  };

  // A new chat — started here or branched — keeps the model it was started with.
  const keepModel = (chatId) => {
    if (resolved.ok) onSettingsChange(withModelChoice(settings, project.root, chatId, { connectionId: resolved.connection.id, model: resolved.model }));
  };

  const messages = chat?.messages || [];
  const shown = editing ? messages.slice(0, editing.index) : messages;
  const running = Boolean(live?.running);
  const last = shown[shown.length - 1];
  const unanswered = !running && !editing && last?.role === 'user';
  const failureHere = failure && failure.chatId === (chat?.id || null) ? failure.message : '';

  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [shown.length, live?.text, live?.reasoning, unanswered]);

  const approve = useCallback((change) => new Promise((resolve) => setApproval({ change, resolve })), []);

  const branchName = () => t('chat.branchName', { name: chat?.name || t('chats.new') });

  /**
   * One turn: a new message (`text`), or the chat's unanswered last question
   * again (`retry`). With `branchFrom`, the turn runs in a new chat holding a
   * copy of those messages, since a stored answer cannot be replaced.
   */
  const run = async ({ text: message = '', retry = false, branchFrom = null }) => {
    if (live || !resolved.ok) return;
    const controller = new AbortController();
    abortRef.current = controller;
    onBusy?.(true);
    setFailure(null);
    setNotice('');
    setLive({ running: true, user: retry ? '' : message, text: '', reasoning: '', tool: '' });
    let target = chat;
    let questionSaved = retry;
    try {
      if (branchFrom) {
        target = await branchChat({ session, messages: branchFrom, name: branchName(), device: settings.device });
        keepModel(target.id);
        await onChanged();
        onChatCreated(target);
      }
      const apiKey = await getApiKey(services.plugin, resolved.connection.id);
      const complete = createCompletion({
        resolved, apiKey, transport: services.transport,
        params: portableParams(conversation?.settings?.model_params),
      });
      const result = await runChatTurn({
        session,
        chat: target,
        text: message,
        retry,
        complete,
        tools: createTools(session.workspace),
        approve,
        signal: controller.signal,
        language: i18n.language,
        today: new Date().toISOString().slice(0, 10),
        device: settings.device,
        onEvent: (event) => {
          if (event.type === 'text') setLive((current) => current && ({ ...current, text: current.text + event.delta }));
          else if (event.type === 'reasoning') setLive((current) => current && ({ ...current, reasoning: current.reasoning + event.delta }));
          else if (event.type === 'step' && event.step > 1) {
            // Each step reasons on its own; keep them apart as the stored thought does.
            setLive((current) => current && ({ ...current, reasoning: current.reasoning && !current.reasoning.endsWith('\n') ? `${current.reasoning}\n` : current.reasoning }));
          } else if (event.type === 'narration') setLive((current) => current && ({ ...current, text: '' }));
          else if (event.type === 'tool_call') setLive((current) => current && ({ ...current, tool: event.call.name }));
          else if (event.type === 'tool_result') setLive((current) => current && ({ ...current, tool: '' }));
          else if (event.type === 'user_saved') questionSaved = true;
          else if (event.type === 'chat_created') {
            target = event.chat;
            keepModel(event.chat.id);
            onChanged().then(() => onChatCreated(event.chat));
          }
        },
      });
      await onChanged();
      if (!result.uploaded) setNotice(t('chat.notUploaded'));
    } catch (error) {
      await onChanged();
      if (error?.name !== 'AbortError') {
        setFailure({ chatId: target?.id || null, message: error?.message || String(error) });
      }
      // A question that never reached the history goes back to the composer
      // rather than being lost.
      if (!questionSaved && message) setText(message);
    } finally {
      abortRef.current = null;
      setLive(null);
      onBusy?.(false);
    }
  };

  const send = () => {
    const message = text.trim();
    if (!message || running || !resolved.ok) return;
    setText('');
    run({ text: message, branchFrom: editing ? messages.slice(0, editing.index) : null });
  };

  const branchOnly = async (copied) => {
    const created = await branchChat({ session, messages: copied, name: branchName(), device: settings.device });
    keepModel(created.id);
    await onChanged();
    onChatCreated(created);
    session.push().catch(() => {});
  };

  const answerApproval = (approved) => {
    approval?.resolve(approved);
    setApproval(null);
  };

  const onKeyDown = (event) => {
    // A hardware keyboard (tablet, Chromebook) sends with Ctrl/⌘+Enter; Enter
    // alone keeps inserting a new line, as on the touch keyboard.
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      send();
    }
  };

  const actions = actionsFor === null ? [] : messageActions({
    index: actionsFor,
    messages,
    t,
    copy: async (content) => setToast(await copyText(content) ? t('chat.copied') : t('chat.copyFailed')),
    edit: (index) => {
      setEditing({ index });
      setText(messages[index].content);
      setTimeout(() => inputRef.current?.focus(), 0);
    },
    retryInBranch: (through) => run({ retry: true, branchFrom: messages.slice(0, through + 1) }),
    branch: (through) => branchOnly(messages.slice(0, through + 1)),
    canRun: resolved.ok,
  });

  return (
    <div className="screen chat-screen">
      <header className="bar">
        {showBack && <button type="button" className="icon" onClick={onBack} aria-label={t('app.back')} disabled={running}><ArrowLeft size={20} /></button>}
        <div className="bar-title">
          <h1 className="ellipsis">{chat?.name || t('chats.new')}</h1>
          <button type="button" className="model-chip" onClick={() => setPicking(true)} disabled={running} aria-label={t('chat.chooseModel')}>
            <span className="ellipsis">{modelLabel}</span><ChevronDown size={14} />
          </button>
        </div>
      </header>
      <SyncStatus status={status} />
      <main className="scroll messages">
        {shown.map((message, index) => (
          <MessageBubble
            key={message.key || message.client_message_id || index}
            message={message}
            onActions={running || editing ? null : () => setActionsFor(index)}
          />
        ))}
        {/* The conversation is re-read when the turn ends; until then the
            question is shown from the turn itself. */}
        {running && live.user && <MessageBubble message={{ role: 'user', content: live.user }} />}
        {running && (
          <div className="bubble assistant">
            {live.reasoning && (
              <details className="thoughts" open={!live.text}>
                <summary>{t('chat.thoughts')}</summary>
                <pre>{live.reasoning}</pre>
              </details>
            )}
            {live.text ? <Markdown>{live.text}</Markdown> : <p className="muted">{live.tool ? t('chat.toolRunning', { tool: live.tool }) : t('chat.thinking')}</p>}
          </div>
        )}
        {unanswered && (
          <div className={`turn-end${failureHere ? ' failed' : ''}`} role={failureHere ? 'alert' : undefined}>
            <p>{failureHere ? t('chat.failed', { message: failureHere }) : t('chat.noAnswer')}</p>
            <div className="turn-end-actions">
              <button type="button" className="primary" onClick={() => run({ retry: true })} disabled={!resolved.ok}>
                <RotateCcw size={18} /> {t('chat.tryAgain')}
              </button>
              {failureHere && <button type="button" onClick={() => setPicking(true)}>{t('chat.chooseModel')}</button>}
            </div>
          </div>
        )}
        {failureHere && !unanswered && <p className="error banner" role="alert">{t('chat.failed', { message: failureHere })}</p>}
        {notice && <p className="notice">{notice}</p>}
        {modelProblem && (
          <div className="notice notice-action">
            <span>{modelProblem}</span>
            <button type="button" className="primary" onClick={() => setPicking(true)}>{t('chat.chooseModel')}</button>
          </div>
        )}
        <div ref={endRef} />
      </main>
      {editing && (
        <div className="editing-bar">
          <Pencil size={16} />
          <span className="grow small">{t('chat.editing')}</span>
          <button type="button" className="icon tiny" onClick={() => { setEditing(null); setText(''); }} aria-label={t('chat.cancelEdit')}><X size={18} /></button>
        </div>
      )}
      <footer className="composer">
        <textarea
          ref={inputRef}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t('chat.placeholder')}
          rows={Math.min(6, Math.max(1, text.split('\n').length))}
          disabled={running}
        />
        {running ? (
          <button type="button" className="icon primary" onClick={() => abortRef.current?.abort()} aria-label={t('chat.stop')}><Square size={20} /></button>
        ) : (
          <button type="button" className="icon primary" onClick={send} disabled={!text.trim() || !resolved.ok} aria-label={t('chat.send')}><Send size={20} /></button>
        )}
      </footer>
      {toast && <div className="toast" role="status">{toast}</div>}
      {actions.length > 0 && (
        <div className="sheet-backdrop" role="dialog" aria-modal="true" aria-label={t('chat.actions')} onClick={() => setActionsFor(null)}>
          <div className="sheet actions-sheet" onClick={(event) => event.stopPropagation()}>
            <p className="actions-preview muted small">{String(messages[actionsFor]?.content || '').replace(/\s+/g, ' ').slice(0, 140)}</p>
            {actions.map((action) => (
              <button
                key={action.id}
                type="button"
                className="row action-row"
                disabled={action.disabled}
                onClick={() => { setActionsFor(null); action.run(); }}
              >
                <action.Icon size={20} className="row-icon" />
                <span className="row-main">
                  <span className="row-title">{action.label}</span>
                  {action.hint && <span className="row-sub">{action.hint}</span>}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
      {approval && <ApprovalSheet change={approval.change} onAnswer={answerApproval} />}
      {picking && (
        <ModelPicker
          connections={settings.connections}
          desktopModelId={desktopModelId}
          current={resolved.ok ? { connectionId: resolved.connection.id, model: resolved.model } : null}
          onPick={pickModel}
          onClose={() => setPicking(false)}
          onOpenSettings={() => { setPicking(false); onOpenSettings(); }}
        />
      )}
    </div>
  );
}

/**
 * What can be done with one message. Everything that changes the course of the
 * conversation continues in a new chat: the shared history only grows, so the
 * answer that is there stays there.
 */
function messageActions({ index, messages, t, copy, edit, retryInBranch, branch, canRun }) {
  const message = messages[index];
  if (!message) return [];
  const isLast = index === messages.length - 1;
  let question = -1;
  if (message.role === 'user') question = index;
  else for (let i = index - 1; i >= 0; i -= 1) if (messages[i].role === 'user') { question = i; break; }

  const list = [{ id: 'copy', Icon: Copy, label: t('chat.copy'), run: () => copy(message.content) }];
  // The last question with no answer is tried again in place, from the chat.
  if (question >= 0 && !(message.role === 'user' && isLast)) {
    list.push({
      id: 'retry', Icon: RotateCcw, label: t('chat.retryInNewChat'), hint: t('chat.newChatHint'),
      disabled: !canRun, run: () => retryInBranch(question),
    });
  }
  if (message.role === 'user') {
    list.push({ id: 'edit', Icon: Pencil, label: t('chat.edit'), hint: t('chat.newChatHint'), run: () => edit(index) });
  }
  list.push({ id: 'branch', Icon: GitBranch, label: t('chat.branch'), run: () => branch(index) });
  return list;
}

function MessageBubble({ message, onActions = null }) {
  const { t } = useTranslation();
  const origin = { export: '', 'this-device': t('chats.fromPhone'), 'other-device': t('chats.fromOther') }[message.origin] || '';
  return (
    <div className={`bubble ${message.role}`}>
      {message.thoughts && (
        <details className="thoughts">
          <summary>{t('chat.thoughts')}</summary>
          <pre>{message.thoughts}</pre>
        </details>
      )}
      {message.role === 'assistant' ? <Markdown>{message.content}</Markdown> : <p className="user-text">{message.content}</p>}
      {(message.timestamp || origin || onActions) && (
        <div className="bubble-foot">
          <span className="bubble-meta">
            {message.timestamp ? new Date(message.timestamp).toLocaleString() : ''}{origin ? ` · ${origin}` : ''}
          </span>
          {onActions && (
            <button type="button" className="icon tiny bubble-more" onClick={onActions} aria-label={t('chat.actions')}>
              <MoreHorizontal size={18} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
