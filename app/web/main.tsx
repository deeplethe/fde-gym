import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './App';
import { AuthProvider } from './components/auth/AuthDialog';
import { initialLang, LangContext, saveLang, type Lang } from './lib/i18n';
import '@fontsource-variable/plus-jakarta-sans';
import '@fontsource/marcellus-sc/latin-400.css';
import './styles.css';

function Root() {
  const [lang, setLangState] = useState<Lang>(() => {
    const l = initialLang();
    document.documentElement.lang = l === 'en' ? 'en' : 'zh-CN';
    return l;
  });
  const setLang = (l: Lang) => { saveLang(l); setLangState(l); };
  return (
    <LangContext.Provider value={{ lang, setLang }}>
      <BrowserRouter><AuthProvider><App /></AuthProvider></BrowserRouter>
    </LangContext.Provider>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><Root /></StrictMode>);
