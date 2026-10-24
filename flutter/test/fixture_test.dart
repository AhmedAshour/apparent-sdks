// The Flutter SDK must send exactly what the Expo SDK sends. test/fixtures/expo_batches.json is made by running the
// Expo SDK (sdk/expo/src) through the same scenario: `node --import ../expo/test/setup.mjs tool/expo_fixture.mjs`.
import 'dart:convert';
import 'dart:io';

import 'package:apparent/apparent.dart';
import 'package:flutter_test/flutter_test.dart';

import 'helpers.dart';

void main() {
  test('batches match what the Expo SDK sends for the same calls', () async {
    final server = FakeServer();
    final a = makeClient(server, MemoryStorage());
    a.start(testConfig());
    await a.ready();
    a.setProperties({'plan': 'pro', 'lang': 'de'});
    a.track('paywall_view', {'source': 'onboarding', 'price': 4.99, 'trial': true, 'coupon': null});
    a.screen('home');
    a.screen('home');
    a.screen('settings', {'tab': 'account'});
    a.identify('user-42');
    a.track('purchase', {'product': 'pro_yearly'});
    a.setProperties({'lang': null});
    a.track('after_unset');
    a.captureError('boom');
    await a.flush();
    a.logout();
    a.track('after_logout', {'n': 1});
    await a.flush();
    await a.shutdown();

    final expected = jsonDecode(File('test/fixtures/expo_batches.json').readAsStringSync()) as List;
    expect(normalize(server.requests), equals(expected));
    // What normalize() hid: real values of the right shape.
    final first = server.requests.first;
    expect(first['v'], sdkVersion);
    expect(first['sa'], isA<int>());
    expect((first['d'] as Map)['anon'], matches(RegExp(r'^[0-9a-f]{32}$')));
    for (final e in (first['e'] as List).cast<Map>()) {
      expect(e['i'], matches(RegExp(r'^[0-9a-f]{32}$')));
      expect(e['t'], closeTo(DateTime.now().millisecondsSinceEpoch, 60000));
    }
  });

  test('the request is a JSON POST to <apiUrl>/i', () async {
    final server = FakeServer();
    final a = makeClient(server, MemoryStorage());
    a.start(testConfig());
    await a.ready();
    await a.flush();
    expect(server.requests, hasLength(1));
    expect(server.urls.single, 'http://fake/i');
    expect(server.headers.single['content-type'], startsWith('application/json'));
    expect(server.requests.single['a'], 'demo');
    expect(server.requests.single['k'], 'test-key');
    await a.shutdown();
  });
}
