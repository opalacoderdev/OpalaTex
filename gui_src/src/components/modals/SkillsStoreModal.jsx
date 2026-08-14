import React, { useCallback, useEffect, useState } from 'react';
import { X, Store, Package, Download, Check, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';

// Skill icon with a graceful fallback to a generic package icon.
function SkillIcon({ src, alt }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <div className="skill-card-icon skill-card-icon-fallback">
        <Package size={28} />
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      className="skill-card-icon"
      onError={() => setFailed(true)}
    />
  );
}

// "Skills Store" window: browse the installable AssetStore catalog and manage
// which runtime skills (SKILL.md) are active for the current project.
export default function SkillsStoreModal({ onClose, projectPath }) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState('catalog');
  const [assets, setAssets] = useState([]);
  const [skills, setSkills] = useState([]);
  const [installingId, setInstallingId] = useState(null);
  const [togglingName, setTogglingName] = useState(null);

  const fetchAssets = useCallback(() => {
    fetch('/api/assets?type=skill')
      .then(r => r.ok ? r.json() : { assets: [] })
      .then(data => setAssets(Array.isArray(data.assets) ? data.assets : []))
      .catch(() => setAssets([]));
  }, []);

  const fetchSkills = useCallback(() => {
    if (!projectPath) { setSkills([]); return; }
    fetch(`/api/skills?projectPath=${encodeURIComponent(projectPath)}`)
      .then(r => r.ok ? r.json() : { skills: [] })
      .then(data => setSkills(Array.isArray(data.skills) ? data.skills : []))
      .catch(() => setSkills([]));
  }, [projectPath]);

  useEffect(() => { fetchAssets(); }, [fetchAssets]);
  useEffect(() => { fetchSkills(); }, [fetchSkills]);

  const activeNames = new Set(skills.filter(s => s.active).map(s => s.name));

  const handleInstall = async (asset) => {
    if (!projectPath || installingId) return;
    setInstallingId(asset.id);
    try {
      const res = await fetch('/api/assets/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: asset.id, projectPath }),
      });
      if (res.ok) fetchSkills();
    } catch {
      // best-effort — the catalog stays browsable even if the install failed
    } finally {
      setInstallingId(null);
    }
  };

  const handleToggleActive = async (skill) => {
    if (!projectPath || skill.mandatory || togglingName) return;
    setTogglingName(skill.name);
    const endpoint = skill.active ? '/api/skills/deactivate' : '/api/skills/activate';
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath, name: skill.name }),
      });
      if (res.ok) fetchSkills();
    } finally {
      setTogglingName(null);
    }
  };

  return (
    <div className="vscode-modal-overlay">
      <div className="vscode-modal flex flex-col" style={{ width: '760px', maxHeight: '85vh', padding: 0 }}>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: '1px solid var(--vscode-border)', backgroundColor: 'var(--vscode-titlebar-bg)' }}>
          <div className="flex items-center" style={{ gap: '8px' }}>
            <Store size={16} />
            <span style={{ fontWeight: 'bold', fontSize: '13px' }}>{t('skillsStore.title', 'Skills Store')}</span>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--vscode-text-fg)', cursor: 'pointer', padding: '2px' }}>
            <X size={16} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex px-4" style={{ borderBottom: '1px solid var(--vscode-border)', gap: '16px', backgroundColor: 'var(--vscode-titlebar-bg)' }}>
          <button
            onClick={() => setActiveTab('catalog')}
            style={{
              background: 'none', border: 'none', padding: '8px 4px', cursor: 'pointer', fontSize: '12px', fontWeight: activeTab === 'catalog' ? 'bold' : 'normal',
              color: activeTab === 'catalog' ? 'var(--vscode-text-fg)' : 'var(--vscode-text-subtle)',
              borderBottom: activeTab === 'catalog' ? '2px solid var(--vscode-accent)' : '2px solid transparent',
            }}
          >
            {t('skillsStore.tabCatalog', 'Catalog')}
          </button>
          <button
            onClick={() => setActiveTab('active')}
            style={{
              background: 'none', border: 'none', padding: '8px 4px', cursor: 'pointer', fontSize: '12px', fontWeight: activeTab === 'active' ? 'bold' : 'normal',
              color: activeTab === 'active' ? 'var(--vscode-text-fg)' : 'var(--vscode-text-subtle)',
              borderBottom: activeTab === 'active' ? '2px solid var(--vscode-accent)' : '2px solid transparent',
            }}
          >
            {t('skillsStore.tabActive', 'Active in project')}
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {!projectPath && (
            <div style={{ fontSize: '12px', color: 'var(--vscode-descriptionForeground)', marginBottom: '12px' }}>
              {t('skillsStore.noProjectHint', 'Open a project to install or activate skills.')}
            </div>
          )}

          {activeTab === 'catalog' && (
            assets.length === 0 ? (
              <div style={{ fontSize: '12px', color: 'var(--vscode-descriptionForeground)' }}>
                {t('skillsStore.emptyCatalog', 'No skills available in the catalog.')}
              </div>
            ) : (
              <div className="skills-grid">
                {assets.map(asset => {
                  const installed = activeNames.has(asset.name);
                  return (
                    <div key={asset.id} className="skill-card">
                      <SkillIcon src={asset.hasIcon ? `/api/assets/icon?id=${encodeURIComponent(asset.id)}` : null} alt={asset.name} />
                      <div className="skill-card-body">
                        <div className="skill-card-title">{asset.name}</div>
                        <div className="skill-card-desc">{asset.desc}</div>
                      </div>
                      <button
                        className="vscode-button skill-card-action"
                        disabled={!projectPath || installed || installingId === asset.id}
                        onClick={() => handleInstall(asset)}
                      >
                        {installed ? (
                          <><Check size={13} /> {t('skillsStore.installed', 'Installed')}</>
                        ) : installingId === asset.id ? (
                          t('skillsStore.installing', 'Installing…')
                        ) : (
                          <><Download size={13} /> {t('skillsStore.install', 'Install')}</>
                        )}
                      </button>
                    </div>
                  );
                })}
              </div>
            )
          )}

          {activeTab === 'active' && (
            skills.length === 0 ? (
              <div style={{ fontSize: '12px', color: 'var(--vscode-descriptionForeground)' }}>
                {t('skillsStore.emptyActive', 'No skills found for this project.')}
              </div>
            ) : (
              <div className="skills-grid">
                {skills.map(skill => (
                  <div key={skill.name} className="skill-card">
                    <SkillIcon src={skill.hasIcon ? `/api/skills/icon?name=${encodeURIComponent(skill.name)}&projectPath=${encodeURIComponent(projectPath)}` : null} alt={skill.name} />
                    <div className="skill-card-body">
                      <div className="skill-card-title">{skill.name}</div>
                      <div className="skill-card-desc">{skill.description}</div>
                    </div>
                    <button
                      className="vscode-button skill-card-action"
                      disabled={skill.mandatory || togglingName === skill.name}
                      onClick={() => handleToggleActive(skill)}
                    >
                      {skill.mandatory ? (
                        t('skillsStore.mandatory', 'Mandatory')
                      ) : skill.active ? (
                        t('skillsStore.deactivate', 'Deactivate')
                      ) : (
                        <><Plus size={13} /> {t('skillsStore.activate', 'Activate')}</>
                      )}
                    </button>
                  </div>
                ))}
              </div>
            )
          )}
        </div>

        {/* Footer */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '12px 16px', gap: '8px', borderTop: '1px solid var(--vscode-border)', backgroundColor: 'var(--vscode-sidebar-bg)' }}>
          <button onClick={onClose} className="vscode-button">{t('skillsStore.close', 'Close')}</button>
        </div>
      </div>
    </div>
  );
}
