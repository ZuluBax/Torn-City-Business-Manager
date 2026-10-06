// Torn "sent you $" payment matching. Made-up data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../js/torn.js');

// Event HTML shaped like Torn's (profile link + text). The exact wording is confirmed against
// a real event before relying on it; the parser is deliberately tolerant.
const ev = (msg, amount = '420,000', xid = '111', name = 'Alpha') => ({
  html: `<a href = "http://www.torn.com/profiles.php?XID=${xid}">${name}</a> sent you $${amount}${msg === null ? '.' : ` with the message: ${msg}`}`,
});
const emp = { id: 'e1', tornId: '111', startDate: '2026-10-01', status: 'active', salaryHistory: [{ effectiveFrom: '2026-10-01', salaryPerDay: 0 }] };
const data = (training = [], payments = []) => ({ employees: [emp], training, payments, expenses: [], income: [], settings: { trainPrice: 420000 } });
const owedTraining = { id: 't1', employeeId: 'e1', date: '2026-10-02', trainCount: 1, pricePerTrain: 420000, trainType: 'paid', createdAt: 'x' };

test('parses sender, amount and message', () => {
  assert.deepEqual(T.parseMoneyEvent(ev('train 1').html), { senderId: '111', senderName: 'Alpha', amount: 420000, message: 'train 1' });
  assert.equal(T.parseMoneyEvent(ev(null).html).message, '');
  assert.equal(T.parseMoneyEvent('Something else happened'), null);
});

test('faction gifts are not money events', () => {
  assert.equal(T.isMoneyEvent('<a href="x?XID=1">Bob</a> gave $50,000,000 to you from Null &amp; Void'), false);
  assert.equal(T.isMoneyEvent(ev('train 1').html), true);
});

test('reads the number of trains in common phrasings', () => {
  for (const [msg, n] of [['train 1', 1], ['Train x2', 2], ['2 trains', 2], ['trains: 3', 3], ['TRAIN#4', 4], ['for training', null], ['', null]]) {
    assert.equal(T.trainCountFrom(msg), n, msg);
  }
});

test('owes nothing + exact amount -> record training and payment together', () => {
  const c = T.classifyMoneyEvent(ev('train 1'), data());
  assert.equal(c.action, 'trainAndPay');
  assert.equal(c.count, 1);
});

test('owes money + exact amount -> pay off the debt', () => {
  assert.equal(T.classifyMoneyEvent(ev('train 1'), data([owedTraining])).action, 'pay');
});

test('odd cases go to review, strangers are ignored', () => {
  assert.equal(T.classifyMoneyEvent(ev('train 1', '420,000', '999'), data()).action, 'ignore');
  assert.equal(T.classifyMoneyEvent(ev('thanks boss'), data()).action, 'review');
  assert.equal(T.classifyMoneyEvent(ev('train 2'), data()).action, 'review'); // $420k for 2 trains
  assert.equal(T.classifyMoneyEvent(ev('train 2', '840,000'), data([owedTraining])).action, 'review'); // owes 420k, sent 840k
});
