const newrelic = require('newrelic');

// Eventos customizados do billing (BudgetStatusChanged, PaymentStatusChanged) —
// alimentam a página "Saga e Microsserviços" do dashboard (repositório infra-kube).
function recordBillingEvent(eventType, attributes) {
  newrelic.recordCustomEvent(eventType, { service: 'billing-service', ...attributes });
}

module.exports = { recordBillingEvent };
