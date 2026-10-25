// CloudFront Function (cloudfront-js-2.0), viewer request on the default (site) behavior only.
// App routes (/gallery, /photos/01J…) have no object in the site bucket: serve /index.html and
// let TanStack Router handle them. Paths whose last segment has a dot (/assets/x.js, /sw.js) are
// real files and pass through. /api/* and /users/* never reach this function, so their 403/404
// stay real (deviation from spec §13.1 error responses, see ARCHITECTURE.md §15).
function handler(event) {
  var request = event.request;
  var lastSegment = request.uri.substring(request.uri.lastIndexOf("/") + 1);

  if (lastSegment.indexOf(".") === -1) {
    request.uri = "/index.html";
  }

  return request;
}
