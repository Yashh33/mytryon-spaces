import { Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, RequireAuth } from "./auth.jsx";
import { ToastProvider } from "./components/Toast.jsx";

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
import Super from "./pages/Super.jsx";

const OWNER_ROLES = ["owner", "superadmin"];

export default function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            path="/"
            element={
              <RequireAuth>
                <Customers />
              </RequireAuth>
            }
          />
          <Route
            path="/customer/:id"
            element={
              <RequireAuth>
                <Customer />
              </RequireAuth>
            }
          />
          <Route
            path="/customer/:id/room/new"
            element={
              <RequireAuth>
                <RoomNew />
              </RequireAuth>
            }
          />
          <Route
            path="/room/:id"
            element={
              <RequireAuth>
                <Room />
              </RequireAuth>
            }
          />
          <Route
            path="/attempt/:id/furniture"
            element={
              <RequireAuth>
                <Furniture />
              </RequireAuth>
            }
          />
          <Route
            path="/attempt/:id/place"
            element={
              <RequireAuth>
                <Place />
              </RequireAuth>
            }
          />
          <Route
            path="/attempt/:id/finish"
            element={
              <RequireAuth>
                <Finish />
              </RequireAuth>
            }
          />
          <Route
            path="/attempt/:id/generating"
            element={
              <RequireAuth>
                <Generating />
              </RequireAuth>
            }
          />
          <Route
            path="/attempt/:id/result"
            element={
              <RequireAuth>
                <Result />
              </RequireAuth>
            }
          />
          <Route
            path="/attempt/:id/adjust"
            element={
              <RequireAuth>
                <Adjust />
              </RequireAuth>
            }
          />
          <Route
            path="/admin"
            element={
              <RequireAuth roles={OWNER_ROLES}>
                <Admin />
              </RequireAuth>
            }
          />
          <Route
            path="/admin/user/:id"
            element={
              <RequireAuth roles={OWNER_ROLES}>
                <AdminUser />
              </RequireAuth>
            }
          />
          <Route
            path="/admin/prompt"
            element={
              <RequireAuth roles={OWNER_ROLES}>
                <AdminPrompt />
              </RequireAuth>
            }
          />
          <Route
            path="/admin/usage"
            element={
              <RequireAuth roles={OWNER_ROLES}>
                <AdminUsage />
              </RequireAuth>
            }
          />
          <Route
            path="/super"
            element={
              <RequireAuth roles={["superadmin"]}>
                <Super />
              </RequireAuth>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </ToastProvider>
  );
}
