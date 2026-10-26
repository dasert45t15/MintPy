// MintPy - Pets feature disabled
window.createPetCompanion = function createPetCompanion() {
  const existing = document.getElementById('petWidget');
  if (existing) existing.remove();
  return {
    populatePetSelect: () => {},
    setPet: () => {},
    applyPetLayout: () => {},
    updatePetState: () => {}
  };
};
