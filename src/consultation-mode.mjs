// One server-side switch for bot access and the ReHub credential environment.
export const consultationBotMode = (env = process.env) => {
  const mode = env.CONSULTATION_BOT_MODE ?? (env.APP_ENV === 'production' ? 'production' : 'test');
  if (!['test', 'production'].includes(mode)) throw Object.assign(new Error('BOT_ACCESS_MODE_INVALID'), { statusCode: 503 });
  return mode;
};
