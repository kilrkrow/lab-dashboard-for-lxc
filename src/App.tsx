import { Search, Hexagon } from 'lucide-react';
import { useState, useEffect, useMemo } from 'react';
import './index.css';

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
  categories: CategoryConfig[];
}

function AppCard({ app }: { app: AppConfig }) {
  const [imgError, setImgError] = useState(false);
  
  return (
    <a href={app.url} className="glass-card" target="_blank" rel="noopener noreferrer">
      <div className="app-icon">
        {!imgError && typeof app.icon === 'string' ? (
          <img 
            src={app.icon} 
            alt={app.name} 
            onError={() => setImgError(true)}
            style={{ width: '28px', height: '28px', objectFit: 'contain' }}
          />
        ) : (
          <span style={{ fontSize: '1.2rem', fontWeight: 'bold' }}>
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
  if (apps.length === 0) return null;
  
  return (
    <section className="category-section">
      <h2 className="category-title">{category}</h2>
      <div className="grid-container">
        {apps.map((app, idx) => (
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

  useEffect(() => {
    fetch('/config.json')
      .then(res => res.json())
      .then(data => {
        setDashboardData(data);
        setLoading(false);
      })
      .catch(err => {
        console.error("Failed to load config.json:", err);
        setLoading(false);
      });
  }, []);

  // Filter apps based on search query
  const filteredConfig = useMemo(() => {
    if (!dashboardData) return [];
    if (!searchQuery) return dashboardData.categories;
    
    const query = searchQuery.toLowerCase();
    
    return dashboardData.categories.map(category => {
      return {
        ...category,
        apps: category.apps.filter(app => 
          app.name.toLowerCase().includes(query) || 
          (app.description && app.description.toLowerCase().includes(query))
        )
      };
    }).filter(category => category.apps.length > 0);
  }, [searchQuery, dashboardData]);

  if (loading) {
    return (
      <div className="app-container" style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh', color: 'var(--text-secondary)' }}>
        Loading dashboard configuration...
      </div>
    );
  }

  return (
    <div className="app-container">
      <header className="header glass-panel">
        <div className="header-title">
          <Hexagon size={28} color="var(--accent-color)" />
          <span>{dashboardData?.title || 'Home Lab'}</span>
        </div>
        
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
          <div style={{ textAlign: 'center', marginTop: '4rem', color: 'var(--text-secondary)' }}>
            No applications found matching "{searchQuery}"
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
