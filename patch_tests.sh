sed -i 's/await import('\''\.\.\/isInRollout?deterministic'\'')/await import('\''\.\.\/isInRollout?deterministic'\'' \/\* @vite-ignore \*\/) as any/' src/__tests__/isInRollout.test.ts
sed -i 's/await import('\''\.\.\/core?error'\'')/await import('\''\.\.\/core?error'\'' \/\* @vite-ignore \*\/) as any/' src/__tests__/core.test.ts
sed -i 's/await import('\''\.\.\/core?success'\'')/await import('\''\.\.\/core?success'\'' \/\* @vite-ignore \*\/) as any/' src/__tests__/core.test.ts
