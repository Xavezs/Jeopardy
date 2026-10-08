import { useState, useRef } from "react";

export function useConfirmDialog() {
  const [dialog, setDialog] = useState(null);
  const dialogResolveRef = useRef(null);

  function showDialog({ title, message, okLabel, showCancel }) {
    return new Promise((resolve) => {
      dialogResolveRef.current = resolve;
      setDialog({ title, message, okLabel, showCancel });
    });
  }
  function appConfirm(message) {
    return showDialog({ title: "Are you sure?", message, okLabel: "Confirm", showCancel: true });
  }
  function appAlert(message) {
    return showDialog({ title: "Heads up", message, okLabel: "OK", showCancel: false });
  }
  function resolveDialog(val) {
    const r = dialogResolveRef.current;
    dialogResolveRef.current = null;
    setDialog(null);
    if (r) r(val);
  }

  return { dialog, appConfirm, appAlert, resolveDialog };
}
