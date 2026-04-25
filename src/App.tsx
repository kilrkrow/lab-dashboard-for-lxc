import { Search, Hexagon, ArrowDownAZ, Pencil } from 'lucide-react';
import { useState, useEffect, useMemo } from 'react';
import './App.css';   // ← changed from index.css if you prefer

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

function App() {
  const [searchQuery, setSearchQuery] = useState('');
  const [dashboardData, setDashboardData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    fetch('/config.json', { cache: 'no-store' })   // helps with live GitOps updates
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
        
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
          {dashboardData.editConfigUrl && (
            <a href={dashboardData.editConfigUrl} target="_blank" rel="noopener noreferrer" title="Edit Configuration" className="glass-panel" style={{padding: '10px', borderRadius: '10px', display: 'flex', alignItems: 'center'}}>
              <Pencil size={19} />
            </a>
          )}

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
        {filteredConfig.length > 0 ? (
          filteredConfig.map((category, idx) => (
            <CategorySection 
              key={idx} 
              category={category.name} 
              apps={category.apps} 
            />
          ))
        ) : (
          <div style={{ textAlign: 'center', marginTop: '6rem', color: 'var(--text-secondary)', fontSize: '1.1rem' }}>
            No applications found matching "{searchQuery}"
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
