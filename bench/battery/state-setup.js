// App dictionaries are declarative task data, never app-name branches.
function run(argv) {
  var request = JSON.parse(argv[0]), descriptor = request.descriptor;
  var app = Application(request.bundle), container = app[descriptor.containers].byId(request.containerID);
  if (!container.exists()) throw new Error('LOCAL_FIXTURE_CONTAINER_MISSING');
  var properties = {};
  Object.keys(descriptor.properties).forEach(function(key) {
    var value = descriptor.properties[key];
    properties[key] = value === '$marker' ? request.marker : value && typeof value.minutesFromNow === 'number'
      ? new Date(Date.now() + value.minutesFromNow * 60000) : value;
  });
  container[descriptor.items].push(app[descriptor.constructor](properties));
  return JSON.stringify({ created: true });
}
