import 'dart:io';

/// Where ids, properties and the waiting events are kept between launches.
abstract class ApparentStorage {
  Future<String?> read(String key);
  Future<void> write(String key, String value);
}

/// Kept in memory only (tests, web).
class MemoryStorage implements ApparentStorage {
  final Map<String, String> values = {};

  @override
  Future<String?> read(String key) async => values[key];

  @override
  Future<void> write(String key, String value) async => values[key] = value;
}

/// One small JSON file per key in a folder (the app's support folder, see `Apparent.start`). Written to a temporary
/// file first and renamed over the old one, so a crash mid-write never leaves half a file.
class FileStorage implements ApparentStorage {
  FileStorage(this.directory);

  final Future<Directory> Function() directory;
  Future<void> _last = Future.value();

  Future<File> _file(String key) async {
    final dir = await directory();
    if (!dir.existsSync()) await dir.create(recursive: true);
    return File('${dir.path}/${key.replaceAll(RegExp(r'[^a-zA-Z0-9_.-]'), '_')}.json');
  }

  @override
  Future<String?> read(String key) async {
    final f = await _file(key);
    return f.existsSync() ? f.readAsString() : null;
  }

  @override
  Future<void> write(String key, String value) {
    // Writes happen one after another, so an older state never lands after a newer one.
    final next = _last.then((_) async {
      final f = await _file(key);
      final tmp = File('${f.path}.tmp');
      await tmp.writeAsString(value, flush: true);
      await tmp.rename(f.path);
    });
    _last = next.catchError((_) {});
    return next;
  }
}
