import React from 'react';
import { useTranslation } from 'react-i18next';
import { MessageSquare, Plus } from 'lucide-react';

export default function ChatList({ conversation, selectedId = null, onOpen, onNew }) {
  const { t } = useTranslation();
  if (!conversation) return <p className="muted pad">{t('app.loading')}</p>;
  return (
    <>
      <div className="pad">
        <button type="button" className="primary wide" onClick={onNew}><Plus size={18} /> {t('chats.new')}</button>
      </div>
      {conversation.chats.length === 0 && <p className="muted pad">{t('chats.empty')}</p>}
      <ul className="list">
        {conversation.chats.map((chat) => {
          const last = chat.messages[chat.messages.length - 1];
          return (
            <li key={chat.id}>
              <button type="button" className={`row${chat.id === selectedId ? ' selected' : ''}`} onClick={() => onOpen(chat.id)}>
                <MessageSquare size={20} className="row-icon" />
                <span className="row-main">
                  <span className="row-title">{chat.name}</span>
                  <span className="row-sub ellipsis">
                    {last ? String(last.content).replace(/\s+/g, ' ').slice(0, 120) : t('chats.messages', { count: 0 })}
                  </span>
                </span>
                <span className="row-meta">{chat.updated_at ? new Date(chat.updated_at).toLocaleDateString() : ''}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}
