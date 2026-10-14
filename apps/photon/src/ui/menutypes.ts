export interface MenuItem {
  label?: string;
  /** Display + keyboard binding, e.g. 'Ctrl+Shift+Z', 'Alt+Ctrl+I', 'F7'. */
  shortcut?: string;
  action?: () => void;
  enabled?: () => boolean;
  checked?: () => boolean;
  submenu?: MenuItem[] | (() => MenuItem[]);
  sep?: boolean;
  /** Bind the shortcut even though the item lives in a submenu (default true). */
  bind?: boolean;
}
export const SEP: MenuItem = { sep: true };
