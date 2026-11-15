// The staff console's frame and its second-factor gate, stood in for the preview: they pull in expo-router and
// React Native, which a static page cannot bundle. The preview is staff with the factor passed (`convexMock.js`).
export const AdminChrome = ({ children }) => children;
export const StaffFactorGate = () => null;
