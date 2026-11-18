import { Outlet } from "@tanstack/react-router";
import {
  BotIcon,
  InboxIcon,
  KeyRoundIcon,
  LayoutTemplateIcon,
  PaletteIcon,
  UserIcon,
} from "lucide-react";
import {
  SettingsLayout,
  SettingsNavGroup,
  SettingsNavLink,
} from "@/components/settings-layout.tsx";

/** Everything under /settings: the signed-in account's own settings (T-557). */
export function UserSettingsLayout() {
  return (
    <SettingsLayout
      label="Account settings"
      nav={
        <>
          <SettingsNavGroup>
            <SettingsNavLink to="/settings/profile" icon={UserIcon}>
              Profile
            </SettingsNavLink>
          </SettingsNavGroup>
          <SettingsNavGroup label="Preferences">
            <SettingsNavLink to="/settings/appearance" icon={PaletteIcon}>
              Appearance
            </SettingsNavLink>
            <SettingsNavLink to="/settings/inbox" icon={InboxIcon}>
              Inbox
            </SettingsNavLink>
            <SettingsNavLink to="/settings/templates" icon={LayoutTemplateIcon}>
              Project templates
            </SettingsNavLink>
          </SettingsNavGroup>
          <SettingsNavGroup label="Access">
            <SettingsNavLink to="/settings/agents" icon={BotIcon}>
              Agents
            </SettingsNavLink>
            <SettingsNavLink to="/settings/tokens" icon={KeyRoundIcon}>
              Personal tokens
            </SettingsNavLink>
          </SettingsNavGroup>
        </>
      }
    >
      <Outlet />
    </SettingsLayout>
  );
}
