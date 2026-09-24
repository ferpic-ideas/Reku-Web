// Missing agreements retain Reku's normal communication and verification policy.
export const requiresAgreementEmailVerification = agreement =>
  agreement?.access_mode !== 'api' && agreement?.email_verification_required !== false;

export const patientCommunicationsSql = (alias = 'a') => {
  if (!/^[a-z_]+$/i.test(alias)) throw new Error('INVALID_SQL_ALIAS');
  return `NOT EXISTS (SELECT 1 FROM agreements communication_agreement
    WHERE communication_agreement.id = ${alias}.agreement_id
      AND communication_agreement.access_mode = 'api'
      AND communication_agreement.communication_sender = 'integrator')`;
};
