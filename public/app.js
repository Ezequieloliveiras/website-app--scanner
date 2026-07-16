const pricingGrid = document.querySelector("#pricing-grid");
const dialog = document.querySelector("#checkout-dialog");
const form = document.querySelector("#checkout-form");
const selectedPlanInput = document.querySelector("#selected-plan");
const dialogTitle = document.querySelector("#dialog-title");
const formMessage = document.querySelector("#form-message");
const closeDialog = document.querySelector("#close-dialog");

let plans = [];

init();

async function init() {
  try {
    plans = await loadPlans();
    renderPlans(plans);
  } catch (error) {
    renderPlansError(error.message || "Nao consegui carregar os planos.");
  }
  bindOpenButtons();
  bindDialog();
}

async function loadPlans() {
  const response = await fetch("/api/plans");
  const data = await response.json().catch(() => ({}));

  if (!response.ok || !Array.isArray(data)) {
    throw new Error(data.message || "Nao consegui carregar os planos.");
  }

  return data;
}

function renderPlans(items) {
  pricingGrid.innerHTML = items
    .map((plan) => {
      const price = formatPrice(plan.monthlyPriceCents);
      const actionLabel = plan.id === "custom" ? "Falar com comercial" : plan.id === "free" ? "Criar conta grátis" : `Assinar ${plan.label}`;
      const buttonClass = plan.highlighted ? "primary-button" : "ghost-action";
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
          <button class="${buttonClass}" data-open-checkout="${plan.id}">
            ${actionLabel}
          </button>
        </article>
      `;
    })
    .join("");
}

function renderPlansError(message) {
  pricingGrid.innerHTML = `
    <article class="price-card highlighted">
      <div class="price-title">
        <h3>Planos indisponiveis</h3>
      </div>
      <p>${escapeHtml(message)}</p>
    </article>
  `;
}

function bindOpenButtons() {
  document.querySelectorAll("[data-open-checkout]").forEach((button) => {
    button.addEventListener("click", () => openCheckout(button.dataset.openCheckout || "premium"));
  });
}

function bindDialog() {
  closeDialog.addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  form.addEventListener("submit", submitCheckout);
}

function openCheckout(planId) {
  const plan = plans.find((item) => item.id === planId) || plans.find((item) => item.id === "premium");
  selectedPlanInput.value = plan.id;
  dialogTitle.textContent = plan.id === "custom" ? "Solicitar plano personalizado" : `Assinar ${plan.label}`;
  formMessage.textContent = "";
  formMessage.classList.remove("error");
  dialog.showModal();
}

async function submitCheckout(event) {
  event.preventDefault();
  const payload = Object.fromEntries(new FormData(form).entries());
  payload.plan = payload.plan || selectedPlanInput.value;

  setLoading(true, "Criando checkout...");

  try {
    const response = await fetch("/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) throw new Error(data.message || "Não consegui criar o checkout.");
    if (!data.checkoutUrl) throw new Error(data.message || "Checkout criado sem URL.");

    setLoading(false, "Tudo certo. Abrindo checkout...");
    window.location.href = data.checkoutUrl;
  } catch (error) {
    setLoading(false, error.message, true);
  }
}

function setLoading(loading, message, isError = false) {
  form.querySelectorAll("button, input").forEach((element) => {
    if (element.type !== "hidden") {
      element.disabled = loading;
    }
  });
  closeDialog.disabled = loading;
  formMessage.textContent = message;
  formMessage.classList.toggle("error", isError);
}

function formatPrice(value) {
  if (value === null || value === undefined) return { main: "Sob consulta", suffix: "" };
  if (value === 0) return { main: "Grátis", suffix: "" };
  const formatted = (value / 100).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL"
  });
  return { main: formatted, suffix: "/mes" };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
