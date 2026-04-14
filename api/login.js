export default function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).end();

  const { password } = req.body;
    const userPass  = process.env.USER_PASS;
    const adminPass = process.env.ADMIN_PASS;

  if (password === adminPass) {
        return res.status(200).json({ role: 'admin' });
  } else if (password === userPass) {
        return res.status(200).json({ role: 'user' });
  } else {
        return res.status(401).json({ error: 'Forkert adgangskode' });
  }
}
