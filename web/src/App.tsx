import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth';
import { Layout } from './components/Layout';
import { LoginPage, ResetPasswordPage } from './pages/Login';
import { ChangePasswordPage } from './pages/ChangePassword';
import { DashboardPage } from './pages/Dashboard';
import { MessagingPage } from './pages/Messaging';
import { ReplySettingsPage } from './pages/ReplySettings';
import { ApprovalQueuePage } from './pages/ApprovalQueue';
import { KnowledgeBasePage } from './pages/KnowledgeBase';
import { ApprovedMemoryPage } from './pages/ApprovedMemory';
import { StudentsGroupsPage } from './pages/StudentsGroups';
import { AdministrationPage } from './pages/Administration';
import { StudentChatPage } from './pages/StudentChat';

export function App() {
  const { admin, loading, totpRequired } = useAuth();

  return (
    <Routes>
      <Route path="/chat" element={<StudentChatPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route
        path="*"
        element={
          loading ? (
            <div className="p-8 text-sm text-slate-500">Loading…</div>
          ) : !admin || totpRequired ? (
            <LoginPage />
          ) : admin.mustChangePassword ? (
            <ChangePasswordPage forced />
          ) : (
            <Layout>
              <Routes>
                <Route path="/" element={<DashboardPage />} />
                <Route path="/messaging" element={<MessagingPage />} />
                <Route path="/reply-settings" element={<ReplySettingsPage />} />
                <Route path="/approvals" element={<ApprovalQueuePage />} />
                <Route path="/approvals/:id" element={<ApprovalQueuePage />} />
                <Route path="/knowledge" element={<KnowledgeBasePage />} />
                <Route path="/memory" element={<ApprovedMemoryPage />} />
                <Route path="/students" element={<StudentsGroupsPage />} />
                <Route path="/admin" element={<AdministrationPage />} />
                <Route path="/account" element={<ChangePasswordPage />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </Layout>
          )
        }
      />
    </Routes>
  );
}
