import { Search, Hexagon, ArrowDownAZ, Pencil, GitBranch, RefreshCw, X } from 'lucide-react';
import { useState, useEffect, useMemo } from 'react';
import './App.css';

export interface AppConfig {
  name: string;
  url: string;
  description?: string;
  icon: string;
}

export interface CategoryConfig {
  name: string;
  apps: AppConfig[];
}

interface DashboardData {
  title: string;
  editConfigUrl?: string;
  categories: CategoryConfig[];
}

interface GitBranchRepo {
  name: string;
  html_url: string;
  description: string | null;
  updated_at: string;
  private: boolean;
}

function AppCard({ app }: { app: AppConfig }) {
  const [imgError, setImgError] = useState(false);
  
  return (
    <a href={app.url} className="glass-card" target="_blank" rel="noopener noreferrer">
      <div className="app-icon">
        {!imgError ? (
          <img 
            src={app.icon} 
            alt={app.name} 
            onError={() => setImgError(true)}
            style={{ width: '28px', height: '28px', objectFit: 'contain' }}
          />
        ) : (
          <span style={{ fontSize: '1.4rem', fontWeight: 'bold', opacity: 0.9 }}>
            {app.name.charAt(0).toUpperCase()}
          </span>
        )}
      </div>
      <div className="app-info">
        <span className="app-title">{app.name}</span>
        {app.description && <span className="app-desc">{app.description}</span>}
      </div>
    </a>
  );
}

function CategorySection({ category, apps }: { category: string, apps: AppConfig[] }) {
  const [isAlphaSort, setIsAlphaSort] = useState(false);
  
  if (apps.length === 0) return null;
  
  const displayedApps = isAlphaSort 
    ? [...apps].sort((a, b) => a.name.localeCompare(b.name))
    : apps;

  return (
    <section className="category-section">
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1.5rem' }}>
        <h2 className="category-title" style={{ marginBottom: 0 }}>{category}</h2>
        <button 
          className={`icon-button ${isAlphaSort ? 'active' : ''}`}
          onClick={() => setIsAlphaSort(!isAlphaSort)}
          title="Toggle Alphabetical Sort"
        >
          <ArrowDownAZ size={18} />
        </button>
      </div>
      <div className="grid-container">
        {displayedApps.map((app, idx) => (
          <AppCard key={idx} app={app} />
        ))}
      </div>
    </section>
  );
}

function GitHubReposFlyout({ 
  isOpen, 
  onClose, 
  repos, 
  onRefresh 
}: { 
  isOpen: boolean; 
  onClose: () => void; 
  repos: GitBranchRepo[]; 
  onRefresh: () => void;
}) {
  const [sortMode, setSortMode] = useState<'recent' | 'alpha'>('recent');
  const [isRefreshing, setIsRefreshing] = useState(false);

  const displayedRepos = useMemo(() => {
    if (!repos.length) return [];
    
    let sorted = [...repos];
    
    if (sortMode === 'recent') {
      sorted.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
    } else {
      sorted.sort((a, b) => a.name.localeCompare(b.name));
    }
    
    return sorted;
  }, [repos, sortMode]);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    await onRefresh();
    setIsRefreshing(false);
  };

  if (!isOpen) return null;

  return (
    <div 
      style={{
        position: 'fixed',
        top: 0,
        right: 0,
        bottom: 0,
        width: '380px',
        background: 'var(--bg-secondary)',
        borderLeft: '1px solid var(--border-color)',
        zIndex: 1000,
        display: 'flex',
        flexDirection: 'column',
        boxShadow: '-4px 0 20px rgba(0,0,0,0.3)'
      }}
    >
      {/* Header */}
      <div style={{ 
        padding: '1rem 1.5rem', 
        borderBottom: '1px solid var(--border-color)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <GitBranch size={20} />
          <span style={{ fontSize: '1.1rem', fontWeight: 600 }}>GitHub Repos</span>
        </div>
        <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)' }}>
          <X size={20} />
        </button>
      </div>

      {/* Controls */}
      <div style={{ 
        padding: '1rem 1.5rem', 
        borderBottom: '1px solid var(--border-color)',
        display: 'flex',
        gap: '0.5rem',
        alignItems: 'center'
      }}>
        <button 
          onClick={handleRefresh}
          disabled={isRefreshing}
          className="icon-button"
          title="Refresh from GitHub"
        >
          <RefreshCw size={16} className={isRefreshing ? 'spin' : ''} />
        </button>

        <div style={{ display: 'flex', gap: '0.25rem', marginLeft: 'auto' }}>
          <button 
            className={`icon-button ${sortMode === 'recent' ? 'active' : ''}`}
            onClick={() => setSortMode('recent')}
            title="Sort by most recently updated"
          >
            Recently touched
          </button>
          <button 
            className={`icon-button ${sortMode === 'alpha' ? 'active' : ''}`}
            onClick={() => setSortMode('alpha')}
            title="Sort alphabetically"
          >
            A-Z
          </button>
        </div>
      </div>

      {/* Repo List */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '1rem' }}>
        {displayedRepos.length === 0 ? (
          <div style={{ color: 'var(--text-secondary)', textAlign: 'center', paddingTop: '2rem' }}>
            No repositories found
          </div>
        ) : (
          displayedRepos.map(repo => (
            <a 
              key={repo.name} 
              href={repo.html_url} 
              target="_blank" 
              rel="noopener noreferrer"
              style={{
                display: 'block',
                padding: '0.75rem 1rem',
                marginBottom: '0.5rem',
                borderRadius: '8px',
                background: 'var(--glass-bg)',
                border: '1px solid var(--border-color)',
                textDecoration: 'none',
                color: 'inherit'
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: '0.25rem' }}>{repo.name}</div>
              {repo.description && (
                <div style={{ fontSize: '0.85rem', opacity: 0.75, lineHeight: 1.4 }}>
                  {repo.description}
                </div>
              )}
              {!repo.description && repo.private && (
                <div style={{ fontSize: '0.8rem', fontStyle: 'italic', opacity: 0.5 }}>
                  Private repository
                </div>
              )}
            </a>
          ))
        )}
      </div>
    </div>
  );
}

function App() {
  const [searchQuery, setSearchQuery] = useState('');
  const [dashboardData, setDashboardData] = useState<DashboardData | null>(null);
  const [repos, setRepos] = useState<GitBranchRepo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [isGitHubOpen, setIsGitHubOpen] = useState(false);

  const fetchRepos = () => {
    fetch('/api/repos', { cache: 'no-store' })
      .then(res => {
        if (!res.ok) throw new Error('Repos API failed');
        return res.json();
      })
      .then(data => setRepos(data as GitBranchRepo[]))
      .catch(err => console.warn("Failed to load GitHub repos:", err));
  };

  useEffect(() => {
    fetch('/config.json', { cache: 'no-store' })
      .then(res => {
        if (!res.ok) throw new Error('Config not found');
        return res.json();
      })
      .then(data => {
        setDashboardData(data);
        if (data.title) document.title = data.title;
        setLoading(false);
      })
      .catch(err => {
        console.error("Failed to load config.json:", err);
        setError(true);
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    fetchRepos();
  }, []);

  const filteredConfig = useMemo(() => {
    if (!dashboardData) return [];
    
    const query = searchQuery.toLowerCase().trim();
    
    return dashboardData.categories.map(category => {
      let filteredApps = category.apps;
      
      if (query) {
        filteredApps = filteredApps.filter(app =>
          app.name.toLowerCase().includes(query) || 
          (app.description && app.description.toLowerCase().includes(query))
        );
      }
      
      return { ...category, apps: filteredApps };
    }).filter(category => category.apps.length > 0);
  }, [searchQuery, dashboardData]);

  if (loading) {
    return <div className="app-container" style={{height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)'}}>
      Loading dashboard...
    </div>;
  }

  if (error || !dashboardData) {
    return <div className="app-container" style={{height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#ff6b6b', textAlign: 'center'}}>
      Could not load config.json<br/>Make sure it exists in the public folder (or via Nginx proxy)
    </div>;
  }

  return (
    <div className="app-container">
      <header className="header glass-panel">
        <div className="header-title">
          <Hexagon size={28} color="var(--accent-color)" />
          <span>{dashboardData.title || 'Home Lab'}</span>
        </div>
        
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          {dashboardData.editConfigUrl && (
            <a href={dashboardData.editConfigUrl} target="_blank" rel="noopener noreferrer" title="Edit Configuration" className="glass-panel" style={{padding: '10px', borderRadius: '10px', display: 'flex', alignItems: 'center'}}>
              <Pencil size={19} />
            </a>
          )}

          <button 
            onClick={() => setIsGitHubOpen(true)}
            className="glass-panel"
            style={{ padding: '10px', borderRadius: '10px', display: 'flex', alignItems: 'center', cursor: 'pointer', border: 'none' }}
            title="GitHub Repositories"
          >
            <GitBranch size={19} />
          </button>

          <div className="search-container">
            <Search size={18} className="search-icon" />
            <input 
              type="text" 
              className="search-bar" 
              placeholder="Search apps..." 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
        </div>
      </header>

      <main>
        {filteredConfig.length > 0 || repos.length > 0 ? (
          <>
            {filteredConfig.map((category, idx) => (
              <CategorySection 
                key={idx} 
                category={category.name} 
                apps={category.apps} 
              />
            ))}
          </>
        ) : (
          <div style={{ textAlign: 'center', marginTop: '6rem', color: 'var(--text-secondary)', fontSize: '1.1rem' }}>
            No applications found matching "{searchQuery}"
          </div>
        )}
      </main>

      <GitHubReposFlyout 
        isOpen={isGitHubOpen} 
        onClose={() => setIsGitHubOpen(false)} 
        repos={repos}
        onRefresh={fetchRepos}
      />
    </div>
  );
}

export default App;