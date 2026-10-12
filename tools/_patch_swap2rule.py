# -*- coding: utf-8 -*-
"""Make doSwap2Board rule-aware: send INFO RULE before SWAP2BOARD."""
import io

p = r"C:\Users\harve\Desktop\Gobang auto\desktop-connect\ui\bridge.js"
with io.open(p, 'r', encoding='utf-8') as f:
    s = f.read()

# 1) dispatcher: pass body into doSwap2Board
old1 = "else if (api === 'swap2board') run = serialMerge(lane, 'swap2board', function () { return doSwap2Board(lane); });"
new1 = "else if (api === 'swap2board') run = serialMerge(lane, 'swap2board', function () { return doSwap2Board(lane, body || {}); });"
assert s.count(old1) == 1
s = s.replace(old1, new1)

# 2) signature + rule injection
old2 = """      function doSwap2Board(lane) {
        return whenBootReady(lane).then(function () {
          return new Promise(function (resolve, reject) {
            var settled = false, out = null, poll = null, guard = null, settleTimer = null;
            var finish = function (ok, v) {
              if (settled) return;
              settled = true;
              lane.captureLine = null;
              if (poll) clearInterval(poll);
              if (guard) clearTimeout(guard);
              if (settleTimer) clearTimeout(settleTimer);
              if (ok) resolve(v); else reject(new Error(v || 'swap2board no answer'));
            };
            lane.captureLine = function (line) {
              var r = parseSwap2Line(line);
              if (r === null) return false;
              out = r;
              return true;
            };
            engCmd(lane.name, 'SWAP2BOARD').then(function () {
              return engCmd(lane.name, 'DONE');
            });"""
new2 = """      function doSwap2Board(lane, body) {
        return whenBootReady(lane).then(function () {
          return new Promise(function (resolve, reject) {
            var settled = false, out = null, poll = null, guard = null, settleTimer = null;
            var finish = function (ok, v) {
              if (settled) return;
              settled = true;
              lane.captureLine = null;
              if (poll) clearInterval(poll);
              if (guard) clearTimeout(guard);
              if (settleTimer) clearTimeout(settleTimer);
              if (ok) resolve(v); else reject(new Error(v || 'swap2board no answer'));
            };
            lane.captureLine = function (line) {
              var r = parseSwap2Line(line);
              if (r === null) return false;
              out = r;
              return true;
            };
            // Rule-aware opening: rapfi picks the SWAP2 book entry per rule
            // (renju weights the forbidden-side balance differently).
            var rule = body && (body.rule === 6 || body.rule === 7 || body.rule === 8) ? 2
                     : (body && ([0, 1, 2, 5].indexOf(body.rule) >= 0 ? body.rule : 0)) || 0;
            var rulePre = (typeof body === 'object' && body && body.rule !== undefined)
              ? Promise.resolve(engCmd(lane.name, 'INFO RULE ' + rule)) : Promise.resolve();
            rulePre.then(function () {
              return engCmd(lane.name, 'SWAP2BOARD');
            }).then(function () {
              return engCmd(lane.name, 'DONE');
            });"""
assert s.count(old2) == 1
s = s.replace(old2, new2)

# 3) runSwapBal Path A: pass the rule
old3 = """            return wsCall('swap2board', {}, 8000);"""
new3 = """            return wsCall('swap2board', { rule: rule }, 8000);"""
assert s.count(old3) == 1
s = s.replace(old3, new3)

with io.open(p, 'w', encoding='utf-8', newline='') as f:
    f.write(s)
print("OK doSwap2Board rule-aware")
