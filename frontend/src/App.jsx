import { Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, RequireAuth } from "./auth.jsx";
import { ToastProvider } from "./components/Toast.jsx";
import { AppHeader } from "./components/AppHeader.jsx";

import Login from "./pages/Login.jsx";
import Customers from "./pages/Customers.jsx";
import Customer from "./pages/Customer.jsx";
import RoomNew from "./pages/RoomNew.jsx";
import Room from "./pages/Room.jsx";
import Furniture from "./pages/Furniture.jsx";
import Place from "./pages/Place.jsx";
import Finish from "./pages/Finish.jsx";
import Generating from "./pages/Generating.jsx";
import Result from "./pages/Result.jsx";
import Adjust from "./pages/Adjust.jsx";
import Admin from "./pages/Admin.jsx";
import AdminUser from "./pages/AdminUser.jsx";
import AdminPrompt from "./pages/AdminPrompt.jsx";
import AdminUsage from "./pages/AdminUsage.jsx";
import Account from "./pages/Account.jsx";
import Super from "./pages/Super.jsx";
import SuperShop from "./pages/SuperShop.jsx";
import SuperLogin from "./pages/SuperLogin.jsx";

const OWNER_ROLES = ["owner", "superadmin"];

function AuthedLayout({ children }) {
  return (
    <>
      <AppHeader />
      {children}
    </>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/super/login" element={<SuperLogin />} />
          <Route
            path="/"
            element={
              <RequireAuth>
                <AuthedLayout>
                  <Customers />
                </AuthedLayout>
              </RequireAuth>
            }
          />
          <Route
            path="/customer/:id"
            element={
              <RequireAuth>
                <AuthedLayout>
                  <Customer />
                </AuthedLayout>
              </RequireAuth>
            }
          />
          <Route
            path="/customer/:id/room/new"
            element={
              <RequireAuth>
                <AuthedLayout>
                  <RoomNew />
                </AuthedLayout>
              </RequireAuth>
            }
          />
          <Route
            path="/room/:id"
            element={
              <RequireAuth>
                <AuthedLayout>
                  <Room />
                </AuthedLayout>
              </RequireAuth>
            }
          />
          <Route
            path="/attempt/:id/furniture"
            element={
              <RequireAuth>
                <AuthedLayout>
                  <Furniture />
                </AuthedLayout>
              </RequireAuth>
            }
          />
          <Route
            path="/attempt/:id/place"
            element={
              <RequireAuth>
                <AuthedLayout>
                  <Place />
                </AuthedLayout>
              </RequireAuth>
            }
          />
          <Route
            path="/attempt/:id/finish"
            element={
              <RequireAuth>
                <AuthedLayout>
                  <Finish />
                </AuthedLayout>
              </RequireAuth>
            }
          />
          <Route
            path="/attempt/:id/generating"
            element={
              <RequireAuth>
                <AuthedLayout>
                  <Generating />
                </AuthedLayout>
              </RequireAuth>
            }
          />
          <Route
            path="/attempt/:id/result"
            element={
              <RequireAuth>
                <AuthedLayout>
                  <Result />
                </AuthedLayout>
              </RequireAuth>
            }
          />
          <Route
            path="/attempt/:id/adjust"
            element={
              <RequireAuth>
                <AuthedLayout>
                  <Adjust />
                </AuthedLayout>
              </RequireAuth>
            }
          />
          <Route
            path="/admin"
            element={
              <RequireAuth roles={OWNER_ROLES}>
                <AuthedLayout>
                  <Admin />
                </AuthedLayout>
              </RequireAuth>
            }
          />
          <Route
            path="/admin/user/:id"
            element={
              <RequireAuth roles={OWNER_ROLES}>
                <AuthedLayout>
                  <AdminUser />
                </AuthedLayout>
              </RequireAuth>
            }
          />
          <Route
            path="/admin/prompt"
            element={
              <RequireAuth roles={OWNER_ROLES}>
                <AuthedLayout>
                  <AdminPrompt />
                </AuthedLayout>
              </RequireAuth>
            }
          />
          <Route
            path="/admin/usage"
            element={
              <RequireAuth roles={OWNER_ROLES}>
                <AuthedLayout>
                  <AdminUsage />
                </AuthedLayout>
              </RequireAuth>
            }
          />
          <Route
            path="/account"
            element={
              <RequireAuth>
                <AuthedLayout>
                  <Account />
                </AuthedLayout>
              </RequireAuth>
            }
          />
          <Route
            path="/super"
            element={
              <RequireAuth roles={["superadmin"]} loginPath="/super/login">
                <AuthedLayout>
                  <Super />
                </AuthedLayout>
              </RequireAuth>
            }
          />
          <Route
            path="/super/shop/:id"
            element={
              <RequireAuth roles={["superadmin"]} loginPath="/super/login">
                <AuthedLayout>
                  <SuperShop />
                </AuthedLayout>
              </RequireAuth>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </ToastProvider>
  );
}
