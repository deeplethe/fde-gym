import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router';
import { useEffect } from 'react';
import { SiteFooter, SiteHeader } from './components/SiteHeader';
import { CasePage } from './pages/CasePage';
import { CasesPage } from './pages/CasesPage';
import { DocsPage } from './pages/DocsPage';
import { AboutPage } from './pages/AboutPage';
import { LeaderboardPage } from './pages/LeaderboardPage';
import { MePage } from './pages/MePage';
import { NotFound } from './pages/NotFound';
import { SessionPage } from './pages/SessionPage';
import { StatusPage } from './pages/StatusPage';
import { AdminPage } from './pages/AdminPage';
import { AccountPage } from './pages/auth/AccountPage';
import { AuthRoute } from './components/auth/AuthDialog';
import { ResetPage } from './pages/auth/ResetPage';

function SiteLayout() {
  const { pathname } = useLocation();
  useEffect(() => { window.scrollTo(0, 0); }, [pathname]);
  return (
    <>
      <div className="flex min-h-screen flex-col">
        <SiteHeader />
        <main className="flex-1 py-8"><Outlet /></main>
        <SiteFooter />
      </div>
    </>
  );
}

export function App() {
  return (
    <Routes>
      <Route element={<SiteLayout />}>
        {/* The site opens on the case library, as a problem site does. What it is all for is on /about. */}
        <Route index element={<Navigate to="/cases" replace />} />
        <Route path="cases" element={<CasesPage />} />
        <Route path="about" element={<AboutPage />} />
        <Route path="cases/:id" element={<CasePage />} />
        <Route path="status" element={<StatusPage />} />
        <Route path="leaderboard" element={<LeaderboardPage />} />
        <Route path="docs" element={<DocsPage />} />
        <Route path="me" element={<MePage />} />
        {/* Sign-in is a dialog; these addresses open it over the case library (old links, e-mails, redirects). */}
        <Route path="login" element={<AuthRoute view="login"><CasesPage /></AuthRoute>} />
        <Route path="register" element={<AuthRoute view="register"><CasesPage /></AuthRoute>} />
        <Route path="forgot" element={<AuthRoute view="forgot"><CasesPage /></AuthRoute>} />
        <Route path="reset" element={<ResetPage />} />
        <Route path="account" element={<AccountPage />} />
        <Route path="admin" element={<AdminPage />} />
        <Route path="*" element={<NotFound />} />
      </Route>
      <Route path="s/:id" element={<SessionPage />} />
    </Routes>
  );
}
