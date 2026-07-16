const pricingGrid = document.querySelector("#pricing-grid");
const dialog = document.querySelector("#checkout-dialog");
const form = document.querySelector("#checkout-form");
const selectedPlanInput = document.querySelector("#selected-plan");
const dialogTitle = document.querySelector("#dialog-title");
const stepCopy = document.querySelector("#checkout-step-copy");
const formMessage = document.querySelector("#form-message");
const closeDialog = document.querySelector("#close-dialog");
const backButton = document.querySelector("#checkout-back");
const nextButton = document.querySelector("#checkout-next");
const submitButton = document.querySelector("#checkout-submit");
const passwordToggle = document.querySelector("#password-toggle");
const discardConfirm = document.querySelector("#discard-confirm");
const discardCancel = document.querySelector("#discard-cancel");
const discardConfirmButton = document.querySelector("#discard-confirm-button");
const WHATSAPP_URL = "https://wa.me/5527997337338?text=Ol%C3%A1%2C%20quero%20falar%20com%20o%20comercial%20sobre%20o%20BipaA%C3%AD.";

const stepPanels = Array.from(document.querySelectorAll("[data-step]"));
const stepIndicators = Array.from(document.querySelectorAll("[data-step-indicator]"));
const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])"
].join(",");
const stepCopies = [
  "Comece com seus dados de acesso.",
  "Complete os dados da empresa e do endereço.",
  "Revise o plano e siga para o pagamento."
];
const fieldLabels = {
  name: "Nome",
  email: "E-mail",
  password: "Senha",
  company: "Empresa",
  cpfCnpj: "CPF ou CNPJ",
  phoneNumber: "WhatsApp",
  postalCode: "CEP",
  address: "Logradouro",
  addressNumber: "Número",
  province: "Bairro"
};

let plans = [];
let selectedPlan = null;
let currentStep = 0;
let isSubmitting = false;
let lastActiveElement = null;

init();

async function init() {
  setupFieldAccessibility();

  try {
    plans = await loadPlans();
    renderPlans(plans);
  } catch (error) {
    renderPlansError(error.message || "Não consegui carregar os planos.");
  }

  bindOpenButtons();
  bindDialog();
}

async function loadPlans() {
  const response = await fetch("/api/plans");
  const data = await response.json().catch(() => ({}));

  if (!response.ok || !Array.isArray(data)) {
    throw new Error(data.message || "Não consegui carregar os planos.");
  }

  return data;
}

function renderPlans(items) {
  pricingGrid.innerHTML = items
    .map((plan) => {
      const price = formatPrice(plan.monthlyPriceCents);
      const actionLabel = plan.id === "custom" ? "Falar com comercial" : plan.id === "free" ? `Começar ${plan.label}` : `Assinar ${plan.label}`;
      const actionClass = plan.highlighted ? "primary-button" : "ghost-action";
      const action =
        plan.id === "custom"
          ? `<a class="${actionClass}" href="${WHATSAPP_URL}" target="_blank" rel="noopener">${actionLabel}</a>`
          : `<button class="${actionClass}" data-open-checkout="${plan.id}">
            ${actionLabel}
          </button>`;
      const features = (plan.features || [])
        .map((feature) => `<li><span class="check" aria-hidden="true">&#10003;</span><span>${escapeHtml(feature.label || feature)}</span></li>`)
        .join("");

      return `
        <article class="price-card ${plan.highlighted ? "highlighted" : ""}">
          ${plan.highlighted ? '<span class="badge">Mais indicado</span>' : ""}
          <div class="price-title">
            <h3>${escapeHtml(plan.label)}</h3>
          </div>
          <div class="price">
            <strong>${price.main}</strong>
            <span>${price.suffix}</span>
          </div>
          <p>${escapeHtml(plan.description)}</p>
          <ul class="feature-list">${features}</ul>
          ${action}
        </article>
      `;
    })
    .join("");
}

function renderPlansError(message) {
  pricingGrid.innerHTML = `
    <article class="price-card highlighted">
      <div class="price-title">
        <h3>Planos indisponíveis</h3>
      </div>
      <p>${escapeHtml(message)}</p>
    </article>
  `;
}

function bindOpenButtons() {
  document.querySelectorAll("[data-open-checkout]").forEach((button) => {
    button.addEventListener("click", () => openCheckout(button.dataset.openCheckout || "premium", button));
  });
}

function bindDialog() {
  closeDialog.addEventListener("click", requestClose);
  form.addEventListener("click", (event) => event.stopPropagation());
  dialog.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) requestClose();
  });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    if (!discardConfirm.hidden) {
      hideDiscardConfirm();
      return;
    }
    requestClose();
  });
  dialog.addEventListener("keydown", trapFocus);
  dialog.addEventListener("close", restorePageAfterClose);
  form.addEventListener("submit", submitCheckout);
  form.addEventListener("input", handleFieldInput);
  form.addEventListener("change", handleFieldInput);
  nextButton.addEventListener("click", goNext);
  backButton.addEventListener("click", goBack);
  passwordToggle.addEventListener("click", togglePassword);
  discardCancel.addEventListener("click", hideDiscardConfirm);
  discardConfirmButton.addEventListener("click", discardAndClose);
}

function openCheckout(planId, trigger) {
  selectedPlan = plans.find((item) => item.id === planId) || plans.find((item) => item.id === "premium") || plans[0];
  if (!selectedPlan) return;

  lastActiveElement = trigger || document.activeElement;
  form.reset();
  clearAllErrors();
  hideDiscardConfirm();
  setLoading(false, "");
  currentStep = 0;
  selectedPlanInput.value = selectedPlan.id;
  dialogTitle.textContent = selectedPlan.id === "custom" ? "Solicitar plano personalizado" : selectedPlan.id === "free" ? `Criar conta ${selectedPlan.label}` : `Assinar ${selectedPlan.label}`;
  updateSummary(selectedPlan);
  updateStep();

  dialog.showModal();
  document.body.classList.add("checkout-open");
  requestAnimationFrame(() => {
    document.querySelector("#checkout-name")?.focus();
  });
}

function goNext() {
  if (!validateStep(currentStep)) return;
  currentStep = Math.min(currentStep + 1, stepPanels.length - 1);
  updateStep();
}

function goBack() {
  currentStep = Math.max(currentStep - 1, 0);
  updateStep();
}

function updateStep() {
  stepPanels.forEach((panel, index) => {
    const isActive = index === currentStep;
    panel.hidden = !isActive;
    panel.classList.toggle("is-active", isActive);
  });
  stepIndicators.forEach((indicator, index) => {
    indicator.classList.toggle("is-active", index === currentStep);
    indicator.classList.toggle("is-complete", index < currentStep);
  });

  stepCopy.textContent = stepCopies[currentStep] || stepCopies[0];
  backButton.hidden = currentStep === 0;
  nextButton.hidden = currentStep === stepPanels.length - 1;
  submitButton.hidden = currentStep !== stepPanels.length - 1;
  nextButton.textContent = currentStep === stepPanels.length - 2 ? "Revisar compra" : "Continuar";
  submitButton.textContent = selectedPlan?.id === "free" ? "Criar conta grátis" : "Continuar para pagamento";
  formMessage.textContent = "";
  formMessage.classList.remove("error");

  const firstField = stepPanels[currentStep]?.querySelector("input:not([type='hidden'])");
  if (dialog.open && firstField) firstField.focus();
}

function setupFieldAccessibility() {
  form.querySelectorAll("input:not([type='hidden'])").forEach((field) => {
    const error = form.querySelector(`[data-error-for="${field.name}"]`);
    if (!error) return;

    error.id = `${field.id || field.name}-error`;
    field.setAttribute("aria-describedby", error.id);
  });
}

function handleFieldInput(event) {
  const field = event.target;
  if (!(field instanceof HTMLInputElement)) return;
  clearFieldError(field);
  if (formMessage.classList.contains("error")) {
    formMessage.textContent = "";
    formMessage.classList.remove("error");
  }
}

function validateStep(stepIndex) {
  const fields = Array.from(stepPanels[stepIndex].querySelectorAll("input:not([type='hidden'])"));
  let firstInvalid = null;

  fields.forEach((field) => {
    if (field.checkValidity()) {
      clearFieldError(field);
      return;
    }

    setFieldError(field, getValidationMessage(field));
    firstInvalid ||= field;
  });

  if (firstInvalid) {
    firstInvalid.focus();
    formMessage.textContent = "Revise os campos destacados para continuar.";
    formMessage.classList.add("error");
    return false;
  }

  return true;
}

function validateAllSteps() {
  for (let index = 0; index < stepPanels.length; index += 1) {
    if (!validateStep(index)) {
      currentStep = index;
      updateStep();
      validateStep(index);
      return false;
    }
  }
  return true;
}

function getValidationMessage(field) {
  const label = fieldLabels[field.name] || "Campo";
  const validity = field.validity;

  if (validity.valueMissing) return `${label} é obrigatório.`;
  if (validity.typeMismatch && field.type === "email") return "Informe um e-mail válido.";
  if (validity.tooShort) return `${label} precisa ter pelo menos ${field.minLength} caracteres.`;
  if (validity.patternMismatch && field.name === "password") return "Use maiúscula, minúscula, número e pelo menos 8 caracteres.";
  if (validity.patternMismatch) return `${label} está em um formato inválido.`;

  return `Revise o campo ${label}.`;
}

function setFieldError(field, message) {
  const error = form.querySelector(`[data-error-for="${field.name}"]`);
  field.setAttribute("aria-invalid", "true");
  if (error) error.textContent = message;
}

function clearFieldError(field) {
  const error = form.querySelector(`[data-error-for="${field.name}"]`);
  field.removeAttribute("aria-invalid");
  if (error) error.textContent = "";
}

function clearAllErrors() {
  form.querySelectorAll("input:not([type='hidden'])").forEach(clearFieldError);
  formMessage.textContent = "";
  formMessage.classList.remove("error");
}

async function submitCheckout(event) {
  event.preventDefault();
  if (isSubmitting) return;

  if (currentStep !== stepPanels.length - 1) {
    goNext();
    return;
  }

  if (!validateAllSteps()) return;

  const payload = Object.fromEntries(new FormData(form).entries());
  payload.plan = payload.plan || selectedPlanInput.value;
  const plan = plans.find((item) => item.id === payload.plan);
  const needsCheckout = plan?.id === "custom" || plan?.id !== "free";

  setLoading(true, needsCheckout ? "Criando checkout..." : "Criando conta...");

  try {
    const response = await fetch("/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) throw new Error(data.message || "Não consegui criar o checkout.");
    if (!data.checkoutUrl) throw new Error(data.message || "Não consegui concluir sua conta.");

    setLoading(false, needsCheckout ? "Tudo certo. Abrindo checkout..." : "Conta criada. Redirecionando...");
    window.location.href = data.checkoutUrl;
  } catch (error) {
    setLoading(false, normalizeCheckoutError(error.message), true);
  }
}

function setLoading(loading, message, isError = false) {
  isSubmitting = loading;
  form.querySelectorAll("button, input").forEach((element) => {
    if (element.type !== "hidden") {
      element.disabled = loading;
    }
  });
  closeDialog.disabled = loading;
  submitButton.classList.toggle("is-loading", loading);
  formMessage.textContent = message;
  formMessage.classList.toggle("error", isError);
}

function normalizeCheckoutError(message) {
  if (!message) return "Não consegui concluir o checkout. Tente novamente.";
  if (/failed|network|fetch|unexpected|syntax/i.test(message)) {
    return "Não consegui conectar ao checkout agora. Tente novamente em alguns instantes.";
  }
  return message;
}

function requestClose() {
  if (isSubmitting) return;
  if (hasFormProgress()) {
    showDiscardConfirm();
    return;
  }
  closeCheckout({ reset: true });
}

function hasFormProgress() {
  const hasValues = Array.from(new FormData(form).entries()).some(([name, value]) => name !== "plan" && String(value).trim() !== "");
  return hasValues || currentStep > 0;
}

function showDiscardConfirm() {
  discardConfirm.hidden = false;
  discardCancel.focus();
}

function hideDiscardConfirm() {
  discardConfirm.hidden = true;
  if (dialog.open) closeDialog.focus();
}

function discardAndClose() {
  closeCheckout({ reset: true });
}

function closeCheckout({ reset = false } = {}) {
  hideDiscardConfirm();
  if (reset) {
    form.reset();
    clearAllErrors();
    currentStep = 0;
  }
  dialog.close();
}

function restorePageAfterClose() {
  document.body.classList.remove("checkout-open");
  hideDiscardConfirm();
  if (lastActiveElement instanceof HTMLElement) {
    lastActiveElement.focus();
  }
}

function trapFocus(event) {
  if (event.key !== "Tab") return;

  const scope = discardConfirm.hidden ? dialog : discardConfirm;
  const focusable = Array.from(scope.querySelectorAll(focusableSelector)).filter((element) => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0;
  });

  if (!focusable.length) return;

  const first = focusable[0];
  const last = focusable[focusable.length - 1];

  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function togglePassword() {
  const password = document.querySelector("#checkout-password");
  const isPassword = password.type === "password";
  password.type = isPassword ? "text" : "password";
  passwordToggle.textContent = isPassword ? "Ocultar" : "Mostrar";
  passwordToggle.setAttribute("aria-label", isPassword ? "Ocultar senha" : "Mostrar senha");
  password.focus();
}

function updateSummary(plan) {
  const price = formatPrice(plan.monthlyPriceCents);
  const features = (plan.features || []).slice(0, 4);
  const billingText = getBillingText(plan, price);

  document.querySelectorAll("[data-summary-plan]").forEach((element) => {
    element.textContent = plan.label;
  });
  document.querySelectorAll("[data-summary-price]").forEach((element) => {
    element.textContent = price.main;
  });
  document.querySelectorAll("[data-summary-period]").forEach((element) => {
    element.textContent = price.suffix;
  });
  document.querySelectorAll("[data-summary-billing]").forEach((element) => {
    element.textContent = billingText;
  });

  const description = document.querySelector("[data-summary-description]");
  if (description) description.textContent = plan.description || "Plano selecionado para acelerar sua entrada de estoque.";

  const featureList = document.querySelector("[data-summary-features]");
  if (!featureList) return;

  featureList.innerHTML = features
    .map((feature) => `<li><span class="check" aria-hidden="true">&#10003;</span><span>${escapeHtml(feature.label || feature)}</span></li>`)
    .join("");
}

function getBillingText(plan, price) {
  if (plan.id === "free" || plan.monthlyPriceCents === 0) return "Conta gratuita, sem cobrança recorrente.";
  if (price.suffix) return "Cobrança mensal no checkout seguro.";
  return "Condições comerciais sob consulta.";
}

function formatPrice(value) {
  if (value === null || value === undefined) return { main: "Sob consulta", suffix: "" };
  if (value === 0) return { main: "Grátis", suffix: "" };
  const formatted = (value / 100).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL"
  });
  return { main: formatted, suffix: "/mês" };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
