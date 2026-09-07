import React from "react";

export default class AppErrorBoundary extends React.Component {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, info) {
    console.error("[app] unrecoverable render error:", error, info);
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <main
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "24px",
          background: "radial-gradient(circle at top, #182658 0%, #070a20 70%)",
          color: "#f4f1ea",
          fontFamily: "Quicksand, sans-serif",
          textAlign: "center",
        }}
      >
        <section style={{ maxWidth: "420px" }}>
          <h2 style={{ color: "#f0b942", marginBottom: "10px" }}>Activity needs to recover</h2>
          <p style={{ color: "#b8bdd6", lineHeight: 1.5 }}>
            The game view stopped rendering. Your room data is still saved on the server.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              marginTop: "12px",
              padding: "10px 20px",
              border: "1px solid #f0b942",
              borderRadius: "999px",
              background: "#f0b942",
              color: "#171126",
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            Reload Activity
          </button>
        </section>
      </main>
    );
  }
}
