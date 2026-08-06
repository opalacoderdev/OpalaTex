import { useEffect, useState } from 'react';
import { Columns2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatMessageContent } from '../utils/formatMessage';

const isHiddenMessage = (message) => (
  message?.role === 'system' && (
    String(message?.content || '').startsWith('[MODE] ') ||
    String(message?.content || '').startsWith('[PLAN APPROVED] ') ||
    String(message?.content || '').startsWith('[PLAN REJECTED] ')
  )
);

function ComparisonPane({ side, chatId, chats, activeProject, scale, isActive, onActivate, onChatChange, onScaleChange }) {
  const { t } = useTranslation();
  const [messages, setMessages] = useState([]);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!activeProject || !chatId) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    fetch(`/api/chat/history?project_name=${encodeURIComponent(activeProject.name)}&chat_id=${encodeURIComponent(chatId)}&t=${Date.now()}`)
      .then((response) => response.ok ? response.json() : Promise.reject(new Error('Could not load chat history')))
      .then((data) => { if (!cancelled) setMessages(data.history || []); })
      .catch(() => { if (!cancelled) setMessages([]); })
      .finally(() => { if (!cancelled) setIsLoading(false); });
    return () => { cancelled = true; };
  }, [activeProject, chatId]);

  const label = side === 'left' ? t('chatComparison.leftPanel') : t('chatComparison.rightPanel');
  const selectedChatName = chats.find((chat) => chat.id === chatId)?.name || '';
  return (
    <section className={`vscode-chat-comparison-pane ${isActive ? 'active' : ''}`} onMouseDown={onActivate} aria-label={label}>
      <header className="vscode-chat-comparison-header">
        <div className="vscode-chat-comparison-title"><Columns2 size={15} /><span>{label}</span></div>
        <select className="vscode-settings-input vscode-chat-comparison-select" title={selectedChatName} value={chatId || ''} onChange={(event) => onChatChange(event.target.value)} aria-label={t('chatComparison.selectChat', { panel: label })}>
          {chats.map((chat) => <option key={chat.id} value={chat.id}>{chat.name}</option>)}
        </select>
      </header>
      <div className="vscode-chat-comparison-scale">
        <label htmlFor={`chat-scale-${side}`}>{t('chatComparison.scale')}</label>
        <input id={`chat-scale-${side}`} type="range" min="50" max="200" step="10" value={Math.round(scale * 100)} onChange={(event) => onScaleChange(Number(event.target.value) / 100)} aria-label={t('chatComparison.scaleFor', { panel: label })} />
        <output>{Math.round(scale * 100)}%</output>
      </div>
      <div className="vscode-chat-history vscode-chat-comparison-history" style={{ ['--chat-font-scale']: scale }}>
        {isLoading ? <div className="vscode-chat-comparison-empty">{t('chatComparison.loading')}</div> : messages.length === 0 ? <div className="vscode-chat-comparison-empty">{t('chatComparison.empty')}</div> : messages.filter((message) => !isHiddenMessage(message)).map((message, index) => {
          const isUser = message.role === 'user';
          return <article key={message.id || index} className="vscode-chat-comparison-message"><div className={`vscode-chat-msg-header ${isUser ? 'chat-header-user' : 'chat-header-agent'}`}>{isUser ? t('chatPanel.you') : t('chatPanel.opalatex')}</div><div className="vscode-chat-msg-content">{formatMessageContent(message.content || '', activeProject?.project_path || '')}</div></article>;
        })}
      </div>
    </section>
  );
}

export default function ChatComparisonPanel({ chats, activeProject, comparisonChats, setComparisonChats, activePanel, setActivePanel, scales, setScales, onSelectChat }) {
  const updateChat = (side, chatId) => {
    setActivePanel(side);
    setComparisonChats((current) => ({ ...current, [side]: chatId }));
    onSelectChat(chatId);
  };
  return <main className="vscode-chat-comparison">
    <ComparisonPane side="left" chatId={comparisonChats.left} chats={chats} activeProject={activeProject} scale={scales.left} isActive={activePanel === 'left'} onActivate={() => setActivePanel('left')} onChatChange={(chatId) => updateChat('left', chatId)} onScaleChange={(scale) => setScales((current) => ({ ...current, left: scale }))} />
    <ComparisonPane side="right" chatId={comparisonChats.right} chats={chats} activeProject={activeProject} scale={scales.right} isActive={activePanel === 'right'} onActivate={() => setActivePanel('right')} onChatChange={(chatId) => updateChat('right', chatId)} onScaleChange={(scale) => setScales((current) => ({ ...current, right: scale }))} />
  </main>;
}
