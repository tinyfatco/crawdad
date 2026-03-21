/**
 * DesktopPane — noVNC desktop stream placeholder.
 * Center panel when display_mode='desktop'. Not yet implemented.
 */

export function DesktopPane() {
  return (
    <div className="desktop-pane">
      <div className="desktop-placeholder">
        <span className="desktop-placeholder-icon">&#x1F5B5;</span>
        <span className="desktop-placeholder-text">Desktop mode</span>
        <span className="desktop-placeholder-sub">Coming soon</span>
      </div>
    </div>
  );
}
