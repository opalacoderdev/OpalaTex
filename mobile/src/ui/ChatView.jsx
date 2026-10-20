import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ChevronDown, Send, Square } from 'lucide-react';
import Markdown from './Markdown.jsx';
import ApprovalSheet from './ApprovalSheet.jsx';
import ModelPicker, { connectionLabel } from './ModelPicker.jsx';
import { SyncStatus } from './ProjectView.jsx';
import { createCompletion, portableParams, resolveChoice, resolveModel } from '../agent/providers.js';
import { createTools } from '../agent/tools.js';
import { effectiveModel, getApiKey, withModelChoice } from '../project/settings.js';
import { runChatTurn } from '../project/turn.js';
import i18n from '../i18n';

export default function ChatView({
  services, settings, project, session, conversation, chat, initialDraft, onDraftUsed,
  onBack, onChatCreated, onChanged, onBusy, onOpenSettings, onSettingsChange, status,
}) {
  const { t } = useTranslation();
  const [text, setText] = useState(initialDraft || '');
  const [live, setLive] = useState(null);
  const [approval, setApproval] = useState(null);
  const [picking, setPicking] = useState(false);
  const abortRef = useRef(null);
  const endRef = useRef(null);

  useEffect(() => { if (initialDraft) onDraftUsed?.(); }, [initialDraft, onDraftUsed]);

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

  const messages = chat?.messages || [];
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [messages.length, live?.text, live?.reasoning]);

  const approve = useCallback((change) => new Promise((resolve) => setApproval({ change, resolve })), []);

  const send = async () => {
    const message = text.trim();
    if (!message || live || !resolved.ok) return;
    setText('');
    const controller = new AbortController();
    abortRef.current = controller;
    onBusy?.(true);
    setLive({ user: message, text: '', reasoning: '', tool: '', error: '', notice: '' });
    try {
      const apiKey = await getApiKey(services.plugin, resolved.connection.id);
      const complete = createCompletion({
        resolved, apiKey, transport: services.transport,
        params: portableParams(conversation?.settings?.model_params),
      });
      const result = await runChatTurn({
        session,
        chat,
        text: message,
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
          else if (event.type === 'chat_created') {
            // A new chat keeps the model it was started with.
            if (resolved.ok) onSettingsChange(withModelChoice(settings, project.root, event.chat.id, { connectionId: resolved.connection.id, model: resolved.model }));
            onChanged().then(() => onChatCreated(event.chat));
          }
        },
      });
      await onChanged();
      setLive(result.uploaded ? null : { notice: t('chat.notUploaded') });
    } catch (error) {
      await onChanged();
      const aborted = error?.name === 'AbortError';
      setLive(aborted ? null : { error: t('chat.failed', { message: error?.message || String(error) }) });
    } finally {
      abortRef.current = null;
      onBusy?.(false);
    }
  };

  const answerApproval = (approved) => {
    approval?.resolve(approved);
    setApproval(null);
  };

  const running = Boolean(live && live.user);

  return (
    <div className="screen chat-screen">
      <header className="bar">
        <button type="button" className="icon" onClick={onBack} aria-label={t('app.back')} disabled={running}><ArrowLeft size={20} /></button>
        <div className="bar-title">
          <h1 className="ellipsis">{chat?.name || t('chats.new')}</h1>
          <button type="button" className="model-chip" onClick={() => setPicking(true)} disabled={running} aria-label={t('chat.chooseModel')}>
            <span className="ellipsis">{modelLabel}</span><ChevronDown size={14} />
          </button>
        </div>
      </header>
      <SyncStatus status={status} />
      <main className="scroll messages">
        {messages.map((message) => <MessageBubble key={message.key} message={message} />)}
        {/* The conversation is re-read when the turn ends; until then the
            question is shown from the turn itself. */}
        {running && <MessageBubble message={{ role: 'user', content: live.user }} />}
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
        {live?.error && <p className="error banner" role="alert">{live.error}</p>}
        {live?.notice && <p className="notice">{live.notice}</p>}
        {modelProblem && (
          <div className="notice notice-action">
            <span>{modelProblem}</span>
            <button type="button" className="primary" onClick={() => setPicking(true)}>{t('chat.chooseModel')}</button>
          </div>
        )}
        <div ref={endRef} />
      </main>
      <footer className="composer">
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
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

function MessageBubble({ message }) {
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
      {(message.timestamp || origin) && (
        <span className="bubble-meta">
          {message.timestamp ? new Date(message.timestamp).toLocaleString() : ''}{origin ? ` · ${origin}` : ''}
        </span>
      )}
    </div>
  );
}
