import React, { useState } from 'react';
import { Plus, MessageSquare, Trash2, Pencil } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export default function ChatSidebar({
  chats,
  activeChatId,
  setActiveChatId,
  setChats,
  activeProject,
  setChatMessages,
  onSwitchChat
}) {
  const { t } = useTranslation();
  const [showNewChatPrompt, setShowNewChatPrompt] = useState(false);
  const [newChatName, setNewChatName] = useState('');
  const [chatToDelete, setChatToDelete] = useState(null);

  const handleRenameChatClick = async (id, currentName, e) => {
    e.stopPropagation();
    if (!activeProject || id === 'main') return;
    
    const newName = window.prompt(t('chatSidebar.renamePrompt', 'Novo nome do chat:'), currentName);
    if (!newName || newName.trim() === '' || newName.trim() === currentName) return;

    try {
      const res = await fetch('/api/chat/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_name: activeProject.name,
          chat_id: id,
          new_name: newName.trim()
        })
      });
      if (!res.ok) throw new Error('Failed to rename chat');
      
      const newChats = chats.map(c => c.id === id ? { ...c, name: newName.trim() } : c);
      setChats(newChats);
    } catch (err) {
      console.error(err);
    }
  };

  const handleSwitchChat = onSwitchChat;

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
        handleSwitchChat('main');
      }
      setChatToDelete(null);
    } catch (err) {
      console.error(err);
      setChatToDelete(null);
    }
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="vscode-sidebar-header">
        <span className="vscode-sidebar-title">{t('chatPanel.header', 'Chats')}</span>
        <button
          onClick={handleCreateChatClick}
          style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--vscode-text-fg)' }}
          title={t('chatSidebar.newChat', 'Novo Chat')}
        >
          <Plus size={14} />
        </button>
      </div>

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

      {/* Button for new chat prominently displayed */}
      <div style={{ padding: '10px' }}>
        <button
          onClick={handleCreateChatClick}
          className="vscode-button"
          style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', height: '32px' }}
        >
          <Plus size={14} /> {t('chatSidebar.newChat', 'Novo Chat')}
        </button>
      </div>

      {/* Chat List */}
      <div className="vscode-sidebar-section flex-1 overflow-y-auto">
        <div className="vscode-sidebar-section-title">{t('chatSidebar.chatHistory', 'Histórico de Chats')}</div>
        <div>
          {chats.map(c => {
            const isActive = activeChatId === c.id;
            return (
              <div
                key={c.id}
                onClick={() => handleSwitchChat(c.id)}
                className={`vscode-project-item ${isActive ? 'active' : ''}`}
                style={{ padding: '6px 10px', display: 'flex', alignItems: 'center', cursor: 'pointer' }}
              >
                <MessageSquare size={14} style={{ marginRight: '8px', color: isActive ? '#4ec9b0' : '#808080' }} />
                <div className="truncate flex-1" style={{ fontSize: '12px' }}>
                  {c.name}
                </div>
                {c.id !== 'main' && (
                  <div style={{ display: 'flex', gap: '4px' }}>
                    <button
                      onClick={(e) => handleRenameChatClick(c.id, c.name, e)}
                      style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#a0a0a0', padding: '2px 4px' }}
                      title={t('chatSidebar.renameChat', 'Renomear Chat')}
                    >
                      <Pencil size={12} />
                    </button>
                    <button
                      onClick={(e) => handleDeleteChatClick(c.id, e)}
                      style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#a0a0a0', padding: '2px 4px' }}
                      title={t('chatSidebar.removeChat', 'Remover Chat')}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
