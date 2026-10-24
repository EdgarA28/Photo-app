// jsdom has no layout: the router's scroll restoration calls window.scrollTo on navigation.
window.scrollTo = () => {};
