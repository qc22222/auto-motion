// console-ui.js — OpenDesign 页面通用交互层(替换原型 demo 的 assets/workbench.js)
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  let toastTimer;
  window.showToast = function (message, title) {
    const toast = $("toast"), toastTitle = $("toastTitle"), toastMessage = $("toastMessage");
    if (!toast) return;
    toastTitle.textContent = title || "已记录";
    toastMessage.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 3000);
  };

  document.querySelectorAll("[data-toast]").forEach((element) => {
    element.addEventListener("click", (event) => {
      if (element.tagName === "A" && element.hasAttribute("download")) return;
      event.preventDefault();
      window.showToast(element.dataset.toast, element.dataset.toastTitle || "当前状态");
    });
  });
  document.querySelectorAll("[data-dialog-open]").forEach((button) => {
    button.addEventListener("click", () => {
      const dialog = document.getElementById(button.dataset.dialogOpen);
      if (dialog && typeof dialog.showModal === "function") dialog.showModal();
    });
  });
  document.querySelectorAll("[data-dialog-close]").forEach((button) => {
    button.addEventListener("click", () => {
      const dialog = button.closest("dialog");
      if (dialog) dialog.close();
    });
  });
  document.querySelectorAll("dialog").forEach((dialog) => {
    dialog.addEventListener("click", (event) => {
      const bounds = dialog.getBoundingClientRect();
      const outside = event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
      if (outside) dialog.close();
    });
  });
})();
